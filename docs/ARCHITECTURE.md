# Shion 架构

Shion 是单用户、自托管的 A 股投研顾问。系统目标不是维持“连续人格活动”，而是可靠地组织研究证据、跟踪投资假设、评估组合风险并有界地推进明确任务。

Mu/Hermes 时代的 `mu` 进程名、数据库名和部分路径继续保留，避免破坏现有部署与历史数据。

## 1. 进程

| 进程 | 职责 |
|---|---|
| `mu` | Node/tsx 大脑，监听 `127.0.0.1:3210` |
| `mu-qq` | QQ WebSocket/REST bridge，监听 `127.0.0.1:3212` |
| `mu-wechat` | 微信 iLink bridge，被动应答 |

bridge 只处理平台协议、白名单和媒体；推理、记忆、任务与工具都在大脑进程。

## 2. 模块

```text
src/
  mu.ts                    依赖装配与生命周期
  core/
    agent-loop.ts          单次 cycle 编排
    loop/tool-loop.ts      主代理/子代理共用的工具循环
    loop/session-store.ts  会话裁剪、压缩、落盘与恢复
    scheduler.ts           多 wake 类型化调度队列
    subagent.ts            worker/reviewer 执行器
    self-review.ts         DoD 自审
    context-assembler.ts   系统上下文装配
  memory/
    store.ts               SQLite/WAL/FTS5
    active-tasks.ts        Task 状态机与有界续跑
    layers/                身份、时间、关系、情景、技能、知识
  providers/               Anthropic/OpenAI 协议与 fallback
  finance/                 Investment Case、决策日志与组合风险
  tools/                   内置、热加载和 MCP 工具
  gateway/webhook/         HTTP、管理 API、静态工作台、outbox
  runtime/                 消息队列与投递路由
scripts/                   QQ/微信 bridge 与回归脚本
  backtest/                A 股历史回测引擎与三类基线策略
  simulation/              标准化模拟账户分析与成交归因
```

## 3. 消息链路

```text
平台 bridge / CLI
  → MessageQueue 串行入队与同发送者连发合并
  → AgentLoop.runCycle
  → 命令拦截或上下文装配
  → runToolLoop 多轮推理与工具调用
  → 回复路由
  → 异步记忆、embedding、整合与会话压缩
```

消息触发的 cycle 回复用户；Task、提醒和系统事件触发的 cycle 默认不直接发送，模型需要调用 `message_send`。

同步 Webhook 窗口为 110 秒。窗口关闭后，最终回复转 QQ 主动投递；三次失败进入持久 outbox。

## 4. 调度器

调度器维护多个 `ScheduledWake`，而不是单一 timer：

| kind | 语义 | 普通消息可取消 | sleep clamp |
|---|---|---:|---:|
| `reminder` | 用户明确提醒 | 否 | 否 |
| `task` | Task 续跑 | 否 | 是 |
| `rest` | 可中断休息 | 是 | 是 |

队列写入 `data/memory/next-wakes.json`，按到期时间排序，只为最早项目挂 Node timer；超长 timer 分段重挂。旧 `next-wake.json` 启动时迁移。

Task wake 以 task id 去重。用户提醒和多个 Task 可以同时存在，不再互相覆盖或饿死。**cron 兜底是死亡螺旋唤醒链的安全网，无条件生效，不依赖有没有待办**：① 有 pending wake 但逾期超 10 分钟没醒 → 兜底；② 无 pending wake 且超 `max_wake_seconds` 无成功 cycle → 兜底唤醒(空闲也唤醒，醒来发现无事再睡，这是链断恢复机制,**别因"省 LLM"删掉**——2026-06-09 事故根因)。

## 5. Task 与子代理

Task 状态：

```text
open → in_progress → in_review → done
                    ↘ blocked ↗
```

硬限制包括活跃 Task 数、每个 Task wake 次数、连续无进展次数、退避上限和 review 轮数。

子代理使用独立消息数组，不进入主 session。限制包括：

- 递归深度 1。
- 同时运行最多 2 个。
- 每个父 cycle 最多 4 个。
- output、turn、input token 和超时上限。
- 默认只能使用受限工具子集。
- timeout 通过 `AbortSignal` 取消 provider；chat 返回后再次检查取消状态，迟到 `tool_use` 不执行。

## 6. 工具执行

`ToolRegistry` 负责注册、保留名称、防覆盖和 schema 输出。

同一模型轮次只有在所有工具都显式标记 `parallelSafe` 时才并行执行；否则保持顺序。当前只对纯读取工具开放。

Shell 分两类：

- 窄白名单内的只读诊断命令直接执行。
- 其余命令生成 10 分钟、一次性的批准号；只有用户发送 `/approve-shell <id>` 才执行原始精确命令。

热加载 Shell 工具也经过同一批准入口，不能绕过。

## 7. 记忆

SQLite 使用 WAL，episodes 与 FTS5 通过 trigger 同步。中文查询采用 FTS → escaped LIKE 兜底；配置 embedding 时增加 cosine 语义检索。

上下文保持稳定前缀：

1. identity + behavior rules（cache）。
2. 关系事实。
3. 时间、近期情景、技能、知识、Task 与触发原因。

关键 JSON 状态使用同目录临时文件、`fsync`、`rename` 的原子写入，避免崩溃留下半截 JSON。

## 8. Provider

`ModelRouter` 依次尝试 primary 和 fallback。发送前清理孤儿工具块；429 进入较长冷却，普通错误进入短冷却。

普通轮次可以 fallback；识别为金融建议的轮次设置 `fallbackPolicy=deny`，防止通用后备模型在主金融模型失败时静默接管。此类轮次只发送金融数据、研究状态和必要核心工具的 schema，以缩小 prompt、降低厂商 function-calling 兼容风险。`/api/status` 返回 provider 选择、成功/失败次数和最近错误，不把“fallback 成功”伪装成主模型健康。

OpenAI provider 负责 schema 降级和 tool-call 格式转换；Anthropic provider保留 prompt/tool cache。两者都接收外部 `AbortSignal`。

## 9. 投研状态与风险闭环

```text
市场/基本面/公告/研报 MCP
  → Investment Case + append-only evidence
  → iFind 主行情 + 腾讯验证源 quorum（冲突 fail-closed）
  → watchdog 行情健康快照 + 交易时段 audit trail
  → 持仓公告确定性 monitor（规范化/去重/重大事件触达）
  → portfolio risk snapshot
  → 情景估值 + 组合归因 + decision outcome ledger
  → Web dashboard / 后续复盘
```

研究状态使用版本化 JSON envelope 并原子替换。损坏文件 fail-closed，避免在读失败后用空状态覆盖真实历史。行情 watchdog 同时保留 cooldown 状态和独立健康快照；生产阈值告警要求 iFind 与腾讯两个独立来源各自携带交易所时间、仍在 freshness 窗口且价格在 20bps 内形成 quorum，验证源缺失、陈旧或冲突只留降级证据、不触发可疑价格告警。公告 monitor 默认每 15 分钟检查持仓近 24 小时公告，不调用 LLM；重大事件必须先成功进入可靠投递链再标记 seen，投递失败会在下一轮重试。组合风险只接受足够新、数量有效且覆盖完整的价格。

`research-intelligence.json` 统一保存 bounded 的行情质量、公告事件、估值、归因、决策结果和交易日验收记录。估值必须由调用方显式提供公司/行业特定且有序的熊、基、牛 PE 假设，并为价格、历史 EPS/BVPS 与前向 EPS 分别保存 source/asOf，逐字段标记 available/stale/missing。组合归因以独立观测的期末权益、净现金流、费用和滑点对持仓贡献做 reconciliation，非零残差会标 degraded。决策结果把 decision/due/observed 三个带时区时间与 `decisionId+horizon` 唯一键一起锁定，再记录基准收益、MFE/MAE，防止提前评价、重复记账和事后挑选成功样本。结果明细只保留最近 200 条，但完成身份和全历史命中/超额汇总独立保存；完成身份达到 10000 条硬容量时明确拒绝写入并要求归档，不静默淘汰旧身份后重新评价。交易日审计在 09:15、09:30、11:30、13:00、14:57、15:00 自动累计实际触发漂移与全天报价覆盖均值；半日市只期望上午三个边界，重叠计数按交易日增量归零，收盘前为 collecting、到收盘才形成 passed/failed。未到真实交易日时只显示“等待证据”，不伪造通过结论。

回测是独立 Python 包：收盘信号下一根开盘执行，模拟 T+1、一手、费用、滑点、停牌和分板块涨跌停。主板/创业科创/北交默认分别按 10%/20%/30%，ST 与上市初期状态由显式 override 或 bar 标志提供。数据缓存带复权元数据；模拟账户通过严格标准化契约导入，拒绝非有限数、非法时间和重复成交 ID。二者均无券商连接，输出只能作为研究证据，不能视为收益保证。

`/api/finance` 聚合持仓、活跃 case、决策、预警、行情健康、组合风险、研究质量证据及最新回测/模拟报告，各部分独立降级。工作台不写研究状态，因此可作为低权限可观测面。`/api/status` 另暴露 watchdog 的多源验证状态、公告 monitor、交易时段审计摘要和存量提醒语义冲突数。

## 10. 安全边界

- HTTP 只绑定回环。
- 浏览器请求必须同源；bridge/curl 无 `Origin` 时允许。
- 请求 body 默认上限 1MB。
- QQ/微信主人白名单默认 fail-closed；仅本地调试可显式设置 `ALLOW_UNAUTHENTICATED_BRIDGE=1`。
- `web_fetch` 校验初始 URL、DNS 结果以及每次重定向，拒绝回环、私网和元数据地址。
- 高权限 Shell 需要真人批准。
- 内置工具名保留，MCP/热加载工具不能覆盖。
- 金融数据不足时拒绝伪精确结论；金融轮次禁止通用 provider fallback。
- 不提供任何实盘下单或券商凭证接入能力。

## 11. 部署与测试

- L1：TypeScript 单测与 Python bridge 纯逻辑测试。
- L2：真实模型、搜索与渠道冒烟。
- L3：`scripts/persona-regression.sh` 的 Shion 行为/召回基线。

提交门禁由 typecheck、lint、coverage、TS/Python tests 和 GitHub Actions 共同执行。

`scripts/deploy.sh` 要求已提交的 tracked working tree，拒绝部署路径内的未跟踪文件，并通过 `git ls-files` manifest 只同步该 revision 的代码和公开工具/技能定义。它不覆盖私有配置与运行记忆，交易日历也只在缺失时初始化。远端安装依赖、typecheck、PM2 重启后，脚本必须从 `/api/status` 验证当前 Git revision；可选在隔离 Python 环境安装并复验 AkShare、NumPy、pandas。

## 12. 每日投研闭环

watchdog 把通过主源+腾讯 quorum 的持仓与待评估决策标的价格交给 `DailyResearchOrchestrator`，并在同一腾讯批次顺带取得沪深300基准。编排器按北京时间交易日幂等维护 `memory/daily-research.json`：首个 09:30 后可信 tick 形成 trailing PE/PB 估值证据，盘中积累高低价、持仓风险线、当日关联事件和逐标的报价覆盖，日终形成 `active_positions_only` 归因。研究覆盖同时核算活跃持仓和已退出但待复盘的决策标的，归因覆盖则单列活跃持仓口径；任一缺口都不会被静默当作成功。单日活跃持仓硬容量为 500，容量内必须为每个标的保留当日循环；总历史明细有界为 2000 条，只淘汰旧日明细，不挤掉当前交易日证据，超出活跃容量则明确失败。没有 forward consensus 时不生成情景估值；没有账户现金、外部现金流、真实费用和滑点时归因明确 degraded，不能冒充完整账户收益。

`investment_decision_record` 对 buy/add/reduce/sell 强制冻结证券代码、决策价、沪深300基准价和自然日观察窗口。每个待评估决策有自己的有界累积器，只保留高/低点、样本数和最新配对行情，因此不受原始日循环截断影响；减仓/卖出后 watchdog 仍继续跟踪该标的。待评决策硬容量为 500，超限时研究循环明确失败并要求归档或关闭旧决策，不截断累积器。只有证券与基准都在 `due_at` 或之后形成可信配对报价，才定格绝对/超额收益、MFE/MAE，并以 decision+horizon 幂等写入 outcome；hold/watch/avoid 仅留日志，不强行套方向性收益。`/api/status`、`/api/finance` 和工作台同时暴露研究/持仓覆盖率、缺价代码、待评/到期积压与最早到期时间、下次监测、全历史命中/平均超额，以及最新循环的关联事件和止损止盈距离。

止损/止盈告警使用跨日状态机：持续处于同一区域不重复，near→breach、线位变更和恢复安全区才再次通知。session audit 只允许边界后的 tick 认领该边界，避免提前 cadence tick 制造负漂移伪失败。
