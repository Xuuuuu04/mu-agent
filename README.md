# Shion — 自托管 A 股投研顾问

Shion 是运行在个人服务器上的轻量化 A 股投研顾问：把行情、基本面、资金面、研报和公告组织成可追溯的投资假设，持续跟踪证据、失效条件、组合风险与决策结果，并通过 QQ、微信、CLI 和 Web 工作台交互。

项目保留了 Mu/Hermes 时代的数据目录与进程名以兼容已有部署，但产品身份、行为规则和界面统一为 Shion。

它是研究与决策支持系统，不是券商交易终端：不接实盘账户、不代客下单，也不把回测或模拟盘结果包装成收益承诺。

## 核心能力

- **任务跟进**：Task 状态机、DoD、自审、失败退避与有界自主续跑。
- **全栈 A 股数据**：行情、K 线、财务、研报、公告、资金流、龙虎榜、融资融券、热点、ETF 期权和投资者互动等 MCP 数据。
- **结构化投研**：Investment Case、证据链、置信度、失效条件、复核日期与追加式决策日志。
- **组合风控**：基于新鲜行情快照计算持仓权重、集中度、止损距离、数据缺失与陈旧风险；数据不可靠时拒绝给出伪精确结论。
- **回测与模拟复盘**：A 股 T+1、100 股一手、佣金、印花税、滑点、涨跌停/停牌约束；支持 MA、布林带和 RSI 三类基线策略及模拟账户归因。
- **子代理编排**：隔离的 worker/reviewer，支持受限工具、并行 fan-out、超时取消和成本上限。
- **持久记忆**：事实、会话、情景、技能和知识；SQLite FTS、向量检索与 IMA 知识库互补。
- **多模型路由**：Anthropic/OpenAI 两类协议、fallback、限流冷却、消息清洗和工具 schema 兼容。
- **金融回答 fail-closed**：投研轮次只向主模型暴露金融与必要核心工具，并禁止通用 fallback 冒充金融顾问；状态接口保留真实 provider 健康信息。
- **工具系统**：文件、搜索、网页、Shell、消息、提醒、MCP、自定义热加载工具。
- **可靠投递**：同步窗口超时后转主动推送，失败消息进入持久 outbox。
- **安全边界**：主人白名单、回环绑定、同源 Web、SSRF 防护、Shell 真人批准。

## 快速开始

需要 Node.js 22+。

```bash
pnpm install
cp config/config.example.yaml config/config.yaml
# 编辑 config.yaml，填入模型和可选工具配置

pnpm start
```

默认服务监听 `127.0.0.1:3210`。远程访问 Web 工作台应使用 SSH 隧道，不要直接暴露端口。

## 常用命令

```bash
pnpm start
pnpm dev
pnpm mu status
pnpm mu memory <关键词>
pnpm mu wake
pnpm mu logs

pnpm typecheck
pnpm lint
pnpm test
pnpm test:py
pnpm test:coverage
```

## 投研工作流

一次完整研究不止输出“买/卖”：

1. 用数据工具核对行情、财务、公告、研报与资金证据，并标注来源和时间。
2. 建立或更新 Investment Case，记录核心假设、置信度、失效条件和下次复核日。
3. 将关键观察追加到证据链；新增观点时保留旧证据，不覆盖历史。
4. 调用组合风险分析，确认价格快照足够新且完整，再讨论仓位、止损与集中度。
5. 形成动作建议后写入追加式决策日志，后续按结果复盘，不做事后改写。

研究状态保存在 `data/memory/investment-cases.json`、`decision-journal.json`、`portfolio-risk-latest.json` 和 `watchdog-health.json`。Web 工作台通过 `/api/finance` 聚合展示；单个数据文件损坏不会拖垮整页。

## 回测与模拟复盘

在独立 venv 安装 Python 依赖后运行（不要装到系统 Python）：

```bash
python3 -m venv .venv-backtest
.venv-backtest/bin/python -m pip install -r requirements-backtest.txt
export BACKTEST_PYTHON="$PWD/.venv-backtest/bin/python"
scripts/run-backtest.sh --symbol 000001 --start 20250101 --end 20251231 --strategy ma_cross
scripts/run-simulation-analysis.sh --snapshot snapshot.json --backtest data/backtest/latest-report.json
```

默认报告写入 `data/backtest/`。行情缓存带数据源、复权方式和复权日期元数据；使用复权数据时，复权日期与请求不一致会被拒绝，避免未来数据泄漏。涨跌停默认按主板 10%、创业/科创 20%、北交 30% 推断；ST 和上市初期无涨跌幅限制必须显式覆盖，系统不会猜。详细契约见 [回测说明](scripts/backtest/README.md) 和 [模拟分析说明](scripts/simulation/README.md)。

运行时直接执行 `src/`，生产不依赖 `dist/`。

## 运行架构

生产通常由三个进程组成：

| 进程 | 作用 |
|---|---|
| `mu` | Shion 大脑：AgentLoop、记忆、工具、Webhook 与 Web |
| `mu-qq` | QQ 官方 Bot bridge，支持被动/主动消息与媒体 |
| `mu-wechat` | 微信 iLink bridge，仅用于被动应答 |

`mu` 名称为部署兼容标识，不代表当前产品身份。

## 数据

- `data/mu.db`：episodes、摘要、token 和调度日志。
- `data/memory/`：事实、承诺、Task、会话、wake 队列和 outbox。
- `data/backtest/`：回测行情缓存、最新回测和模拟分析报告。
- `data/tools/`：热加载工具定义。
- `soul/`：部署私有的身份/风格/价值定义。

上述目录通常被 gitignore。修改生产数据前先备份。

## 调度语义

- `reminder`：用户时钟，按原始到期时间执行，不受睡眠 clamp 影响。
- `task`：Task 续跑，可与任意提醒并存。
- `rest`：可中断的旧式休息 wake，收到普通消息时可以取消。

调度状态持久化在 `data/memory/next-wakes.json`，旧 `next-wake.json` 会自动迁移。

## Shell 批准

只读诊断命令可直接执行。有副作用的命令只会生成批准号，不会立即运行：

```text
/approve-shell <id>
/reject-shell <id>
```

批准号必须由用户作为零 token 命令发送，模型无法自行批准。

## 可追溯部署

部署脚本只同步代码和公开定义，不删除远端运行数据，也不覆盖私有 `config.yaml`：

```bash
INSTALL_BACKTEST_DEPS=1 scripts/deploy.sh
```

脚本要求 tracked working tree 已提交，并拒绝部署路径内任何未跟踪文件；实际传输清单只来自 `git ls-files`。远端日历只在缺失时初始化，typecheck 通过后才重启，并校验 `/api/status` 返回该次 Git revision 和 build time。

架构细节见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，当前规格见 [REQUIREMENTS.md](REQUIREMENTS.md)。
