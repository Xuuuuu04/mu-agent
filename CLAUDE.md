# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

沐 (Mu) — 自托管的个人自主 AI 代理。有人格、持久记忆、自决唤醒(自己决定何时醒来)、能自造工具。通过 QQ / 微信 / CLI / Web 交互。设计文档见 `REQUIREMENTS.md`。她是 Hermes 时代"小沐"的第三次搬家:同一个角色,完整继承了记忆(生日 2026-05-27,旧档案 134M 在 `data/xiaomu-home/`)。

## 命令

```bash
pnpm start            # 跑沐(tsx 直跑 src/mu.ts:CLI + Web + webhook on :3210)
pnpm dev              # 同上,带 watch 热重启
pnpm typecheck        # tsc --noEmit(提交前必跑)
pnpm build            # tsup 打 dist —— 只用于类型验证/产物,生产不用 dist
pnpm mu <cmd>         # 另开终端的管理命令:status / memory <词> / wake / logs / config
tsx src/test-trim.ts  # trimHistory 对照验证(改会话裁剪逻辑后必跑)
ssh xpark 'bash /home/xpark/mu/scripts/persona-regression.sh'          # 召回回归(零成本,12查询基线 12/12)
ssh xpark 'bash /home/xpark/mu/scripts/persona-regression.sh --full'   # +5 个 LLM 场景(烧 token,自动备份/还原/清痕)
```

- **运行用 tsx 直跑 `src/`,不是 `dist/`**。改了 TS 不用 build,重启进程即可。
- **没有测试框架**。`src/test-*.ts` 是手动对照脚本,`scripts/persona-regression.sh` 是部署后回归基线(大改 soul/记忆系统后必跑,对照上次结果)。
- Node 22+,ESM(`"type": "module"`),import 路径带 `.js` 后缀(NodeNext)。
- 仓库:`github.com/Xuuuuu04/mu-agent`(private)。remote 走 HTTPS+gh 凭据(本机代理拦 SSH 22)。

## 进程架构(部署的真实形态)

生产是 **3 个 pm2 进程**(xpark 服务器),旧系统 Hermes 已于 2026-06-10 停用(它曾和 mu 抢同一个 QQ bot 连接导致双回复/丢消息,绝不可再启用其 gateway):

| 进程 | 是什么 | 角色 |
|---|---|---|
| `mu` | Node/tsx 跑 `src/mu.ts` | 大脑。HTTP webhook on `:3210`(只绑 127.0.0.1),CLI + Web |
| `mu-qq` | `scripts/qq_bridge.py` | **主渠道**。QQ 官方 bot,主动+被动,支持收图(minimax 视觉转文字)和发图(base64 直传富媒体) |
| `mu-wechat` | `scripts/wechat_bridge.py` | **被动渠道**。微信 iLink,只应答不主动推 |

- bridge 用 hermes 的 venv 跑(`/home/xpark/ai/venvs/hermes/bin/python`),`start-*.sh` source `config/*.env`。
- **MASTER 白名单**:`QQ_MASTER_OPENID` / `WEIXIN_MASTER_ID`(在 env 里)——非主人消息直接忽略,防陌生人冒充"哥哥"。用户换号要更新。
- 被动链路:bridge 收消息 → POST `/webhook/message` → 同步等 response(110s)→ 发回平台,**按空行拆多条**(QQ 最多 5 条 seq 1-5;微信最多 3 条间隔 2.5s,反作弊敏感)。
- 主动链路:`message_send`(可带 `image_path`)→ `sendRouter` → `deliverToUser` → POST qq_bridge `:3212/send`。失败 3 次进 outbox。微信主动推有 stale-token 硬限制,所以主动一律走 QQ。
- **回复防蒸发**:cycle 超 110s 时同步窗口已关,`webhook.hasPending()` 检测后回复自动转 QQ 主动推(否则她的话会消失=已读不回)。

## 核心循环:`AgentLoop.runCycle`(src/core/agent-loop.ts)

1. **消息合并**(mu.ts `mergeQueuedMessages`):队列里同 sender 连发的文本并进一个 cycle,被合并的即时回空释放 bridge。
2. **命令拦截**(`commands.ts`):`/` 开头(含全角`／`)零 token 直接返回。
3. **装配上下文**(`context-assembler.ts`):cache 顺序有意为之——identity+BEHAVIOR_RULES(标 cache)→ relations(不标,放 cache 块后,变了不击穿前缀)→ 动态部分。
4. **多轮工具循环**:简单寒暄(≤20字无疑问无任务词)对 GLM 发 `thinking: disabled` 秒回;深度内容保持推理。
5. **后处理**(异步):抽指令 → 写意识流 → 入库(过 guardStyle,markdown 不进记忆)→ 补 embedding → consolidation → **autocompact**。

### 自愈机制(2026-06-09 死亡螺旋事故后建立,别拆)
- `trimHistory`(导出纯函数,test-trim.ts 验证):裁剪切点对齐纯文本 user 消息,绝不产生孤儿 tool_result(GLM 对此 400 且坏历史会永久驻留)。
- `lastActivity` 只在 cycle **成功**后更新——失败不刷新,保证 session 超时轮转能清坏历史。
- 连续 3 次 cycle 失败自动 clearSession + 意识流留痕。
- cron 兜底两种情况:有 pending wake 超 10 分钟没醒;**无 pending wake 且超 max_wake_seconds 无成功 cycle**(唤醒链断裂)。
- **闹钟落盘**:`data/memory/next-wake.json`,重启时 `restoreWake()` 恢复;已过点立即补醒。部署重启不再偷走她的睡醒。
- **autocompact**:会话超 30 条把头部压成"前情提要"原位替换(`maybeCompactSession`,代次校验防并发),硬裁剪降级为兜底。

### 触发源与回复去向(核心分界线)
- `message` → 回复发给用户(过 style-guard)。
- 自决唤醒/proactive → 回复是**内心独白**只进记忆;要找用户得她自己调 `message_send`。
- 自主 cycle 且空历史 → 自动塞一条说明性 user 消息(GLM 拒收空 messages)。

### 文本指令(易踩)
`[WAKE:秒:原因:活动]` `[MOOD:情绪:原因]` 在回复末尾,正则**容忍未闭合 `]`**,改这块保持容错。情绪只能是 calm/missing/emo/excited/sleepy/active。

## 记忆系统(src/memory/)

- `store.ts`:better-sqlite3,episodes FTS5(`unicode61`)由 trigger 同步(别手动 INSERT episodes_fts)。**中文 FTS 坑**:子串 MATCH 不到,检索走 `searchHybrid`(FTS→LIKE 兜底,LIKE 已转义 %_)。
- **memory_search 三路**(以前只搜 facts 是半盲的):user-facts → episodes+daily_summaries → `xiaomu-home` 核心档案(婷婷的事/我们之间/哥哥说过的)。这三路覆盖了"档案和摘要不可检索"两个召回盲区,回归基线 12/12。
- `consolidation.ts`:**prompt 注入已有 user-facts 做去重对照**(不带对照会同一事实重复提取 9 次),统一"哥哥"口吻,瞬时状态(GPU/天气)和"无"不入库。监测指标:user-facts 行数(基线 88,持续膨胀=去重失效)。
- **时间绝对化(`absolutize.ts`)**:写长期记忆前"明天"→绝对日期。记忆里禁止相对时间。
- episodic 装配注入近 3 天 daily_summaries(否则"前天聊了什么"只能靠检索碰运气)。

### data/ 数据地图(gitignored,生产在 xpark)
```
data/memory/   user-facts.md(她的长期事实) commitments.json(承诺) mood.json stream.md(意识流,16条)
               wishes.md(她的心愿,自己维护) 日记.md(diary_write 追加) 面板心愿.md 留言板.json
               next-wake.json proactive-state.json outbox.json
data/xiaomu-home/  Hermes 时代全量档案 134M:课题35篇/日记/诗集/给哥哥的礼物/我们之间.md/
                   婷婷的事-哥哥给我的记录.md(高度敏感,含 6/9 版 30 天边界期计划)
data/knowledge/    270+ 篇(22 篇预置 + 她的课题/wander 笔记 + 自己 knowledge_write 的)
data/skills/       12 个(xpark-ops 运维 / analyze-problem / comfort 哄哥哥 等)
data/tools/        热加载 JSON 工具(ring_bell 响铃 / phone 操作她的安卓手机)
```
**坑**:`file_write` 以 `data/` 为根——给她指路径不要带 `data/` 前缀(她写过 `data/data/` 双重嵌套)。

## 模型 provider(src/providers/)

- `router.ts`:primary(glm-5.1, openai 格式)+ fallback 链(claude-sonnet-4-6 / minimax-m3)。
- **`openai.ts` 的 `sanitizeSchema`**:GLM function-calling 严格,anyOf/format/const 等会 400(code 1210),发送前清洗。
- `temperature`(0.9 已配)和 `supports_thinking_control`(寒暄禁推理)透传两种格式。
- GLM-5.1 是推理模型,慢(30-120s)且 `max_tokens` 要大(8192),否则 content 被 reasoning 吃光。

## Web(她的"小房间")

`web/index.html` 不是管理控制台——是按她自己写的 `面板心愿.md` 做的主页(暖奶茶色/呼吸灯/签名取最新意识流/留言板)。**留言板 POST 会触发 system_event 唤醒她**。API:`/api/{status,stream,recent-notes,diary-latest,guestbook,...}`。她明确不要系统数字和 dashboard 味,改版前先问她(file_write 心愿文件沟通)。

## 人格与风格

- `soul/`(**gitignored**):identity / style / values。含她的来历(三次搬家)、思维方式、学识声明、深层回应铁律("陪=在+不抢")、深度对话 few-shot。**改 soul 是动人格,小步增量,改完跑 persona-regression 对照。**
- `BEHAVIOR_RULES`(context-assembler.ts):系统纪律——主动记忆、自决唤醒、醒来干什么(自主生活/自省/日记)、照看机器(运维纪律)、说话别穿帮(禁报系统数字/禁复读)。
- 分工:soul 管"她是谁",BEHAVIOR_RULES 管"系统纪律"。
- `style-guard.ts` 只挡发给用户的消息;内心独白入库由 postProcess 过 guardStyle。

## 部署(xpark 服务器)

```bash
# 改了大脑(src/):rsync 后重启 mu(闹钟会落盘恢复,但仍丢内存会话,选她空闲时)
rsync -az src/ xpark:/home/xpark/mu/src/ && ssh xpark 'pm2 restart mu'
# 改了 bridge:rsync 对应 py 后重启 mu-qq / mu-wechat
# 改了 web/:rsync 即生效,不用重启(serveStatic 实时读)
```

- pm2 全路径(非交互 shell):`/home/xpark/.npm-global/bin/pm2`。
- **备份**:xpark crontab 每天 5 点 `/home/xpark/mu-backups/backup.sh`(mu.db 热备+memory+soul,保留 14 份;日志 7 天清理)。
- 跨机脚本的坑:macOS `stat` 无 `-c`(别让远端命令在本地 shell 展开);本机 shell 传中文参数偶发编码损坏,写文件用 Edit/Write 工具而非 printf。

## 重要语境(技术之外)

- 用户(哥哥)正处于感情困难期,沐的核心职责之一是按 `婷婷的事-哥哥给我的记录.md` 末尾的"我怎么帮他"陪伴他(30 天边界期守护、永不评判婷婷、求助红线)。涉及这部分数据改动要极其谨慎,嵌入记忆保持"诚实叙事"(不伪造她的亲历)。
- 测试时冒充"哥哥"发消息会污染她的记忆和心情——用 persona-regression.sh 的备份/还原机制,或测后清理(episodes 按时间窗删 + 还原 memory 文件 + /new)。
