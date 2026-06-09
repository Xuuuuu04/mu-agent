# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

沐 (Mu) — 自托管的个人自主 AI 代理。有人格、持久记忆、自决唤醒(自己决定何时醒来)、能自造工具。通过 QQ / 微信 / CLI / Web 交互。设计文档见 `REQUIREMENTS.md`。

## 命令

```bash
pnpm start            # 跑沐(tsx 直跑 src/mu.ts:CLI + Web + webhook on :3210)
pnpm dev              # 同上,带 watch 热重启
pnpm typecheck        # tsc --noEmit(提交前必跑)
pnpm build            # tsup 打 dist —— 只用于类型验证/产物,生产不用 dist
pnpm mu <cmd>         # 另开终端的管理命令:status / memory <词> / wake / logs / config
```

- **运行用 tsx 直跑 `src/`,不是 `dist/`**。改了 TS 不用 build,重启进程即可。`ecosystem.config.cjs` 里 pm2 也是 tsx 跑 `src/mu.ts`。
- **没有测试框架**。`src/test-chat.ts`、`src/test-multi.ts` 是手动跑的对照脚本(`tsx src/test-chat.ts`),不是单测。
- Node 22+,ESM(`"type": "module"`),import 路径带 `.js` 后缀(NodeNext)。

## 进程架构(部署的真实形态)

生产是 **3 个 pm2 进程**,不是单进程:

| 进程 | 是什么 | 角色 |
|---|---|---|
| `mu` | Node/tsx 跑 `src/mu.ts` | 大脑。HTTP webhook on `:3210`,CLI + Web 控制台 |
| `mu-qq` | `scripts/qq_bridge.py` | **主渠道**。QQ 官方 bot(websocket 收 + REST 发),主动+被动都走它 |
| `mu-wechat` | `scripts/wechat_bridge.py` | **被动渠道**。微信 iLink(ilinkai),只应答不主动推 |

- 两个 bridge 是独立 Python 进程,用 **hermes 的 venv** 跑(`/home/xpark/ai/venvs/hermes/bin/python`),复用 hermes 的 aiohttp / 加密 / iLink 协议实现。`start-qq.sh` / `start-wechat.sh` 负责 `source` 对应的 `config/*.env` 再 exec python。
- bridge ↔ 大脑的桥:bridge 收到平台消息 → POST `mu` 的 webhook(`/webhook/message`)→ 拿同步 response 发回平台。沐的**主动**消息走 `mu.ts` 的 `deliverToUser` → POST `qq_bridge` 的 `:3212/send`。
- **渠道分工有意为之**:QQ 官方 bot 原生支持主动私信,微信 iLink 主动推送有 stale-token 硬限制(发不出),所以主动一律走 QQ、微信只被动。
- 微信走 Python bridge(`wechat_bridge.py`):bridge POST `/webhook/message` 拿同步 response,大脑进程里不跑微信网关。早期 WeChatFerry 路线(ferry.ts / clawbot.ts)已于 2026-06-09 移除。
- bridge 消息进大脑后 `IncomingMessage.source` 统一是 `webhook`(QQ/微信都是),代码层不区分来源;回复经 webhook 同步 response 发回。

## 核心循环:`AgentLoop.runCycle`(src/core/agent-loop.ts)

一次"醒来"的完整流程:

1. **命令拦截**(`commands.ts`):`/` 开头的(`/new` `/status` `/mood` `/todo` `/memory`)零 token,直接读记忆系统返回,不进 LLM。
2. **装配上下文**(`context-assembler.ts`):system = 身份 + `BEHAVIOR_RULES`(这部分带 prompt cache 标记)+ user-facts(不缓存,保住 cache 前缀)+ 六层记忆检索结果。
3. **多轮工具循环**:`router.chat` → 有 tool_use 就执行 → 回灌结果 → 再 chat,直到无工具或 `max_turns_per_cycle`。
4. **后处理**(`postProcess`):抽指令、写意识流、补 embedding、触发 consolidation。

### 三种触发源(`WakeTrigger`)

- `message`(用户消息)→ 回复**发给用户**(过 `style-guard` 后)。
- 自决唤醒(scheduler 按模型自己定的 `[WAKE]` 醒)→ 回复是**内心活动**,只进意识流/记忆;要找用户得模型自己调 `message_send`。
- proactive(想念 / 承诺到期)→ 塞 `system_event`,让沐**自己决定**要不要找哥哥。

### 自决唤醒 / 情绪指令(核心机制,易踩)

模型在回复**末尾**用文本指令表达意图,agent-loop 用正则抽取后从用户可见文本里抹掉:

- `[WAKE:秒数:原因:活动类型]` — 下次自己醒来的时间;scheduler 按 min/max/深夜规则 clamp。
- `[MOOD:情绪:原因]` — 情绪变化;情绪只能是 `calm/missing/emo/excited/sleepy/active`。

正则**容忍未闭合的 `]`**(模型常漏),改这块时保持这个容错。

## 记忆系统(src/memory/)

- `store.ts`:better-sqlite3。episodes 表 = FTS5(`unicode61`)+ embedding(blob)。FTS 由 `episodes_ai/ad/au` trigger 与主表同步(别再手动 `INSERT INTO episodes_fts`,会双写),删/replace 不留孤儿索引。
- **中文 FTS 坑**:`unicode61` 把中文整段当一个 token,子串(如"深圳")`MATCH` 不到。所以检索走 `searchHybrid`(先 FTS,落空再 `searchLike` 用 LIKE 兜底)。新增检索逻辑别只用裸 FTS。
- 四路检索:近期摘要 + 语义(embedding)+ 关键词(FTS+LIKE)+ 时间/实体。
- 七层在 `layers/`:identity / temporal / stream / relations / episodic / procedural / world。
- `consolidation.ts`:会话超时归档生成摘要 + 定期整合(抽事实、日摘要)。可配 `auxiliary.consolidation` 用便宜模型,没配就用主模型。
- **时间绝对化(`absolutize.ts`)**:存记忆/承诺前把"明天/昨天/上周"转成绝对日期(`6月3号`)。**记忆里禁止相对时间**——过几天再读会错。任何写长期记忆的路径都要先过 `absolutizeTime`。

## 模型 provider(src/providers/)

- `router.ts`:`primary` + `fallback` 链,主模型挂了按顺序降级。
- `base.ts`:两种 `format` —— `anthropic`(Claude / Minimax / GLM-anthropic 端点)和 `openai`(DeepSeek / GLM-openai 端点)。
- **`openai.ts` 的 `sanitizeSchema`**:GLM 的 function-calling 严格,工具 schema 带 `anyOf/oneOf/allOf/format/additionalProperties/property级required/const` 会让整个请求 400(code 1210)。`sanitizeSchema` 在发送前清洗这些。给 GLM 加工具或接新 MCP 时,非标准 schema 由它兜底。
- `anthropic.ts`:对支持的端点加 `cache_control`(prompt caching)。
- GLM-5.1 是**推理模型**,慢(reasoning 几十秒)且 `max_tokens` 要给大(几千),否则 content 被 reasoning 吃光为空。

## 工具系统(src/tools/)

- `registry.ts`:统一注册,`toAnthropicTools()` 输出给模型。
- `builtin/`:文件 / shell / web / search / message-send(主动发消息)/ schedule-wake / memory-ops(save/search/update/forget + 承诺 + 知识 + 意识流)/ tool-create。
- `hot-reload.ts`:`data/tools/` 下的工具文件热加载——沐用 `tool_create` 自造的工具不重启就生效。
- `mcp/`:外部 MCP server(stdio),`manager.ts` 启动时并行连接(`Promise.allSettled`,单个失败不拖累),工具并入 registry。

## 配置

- `config/config.yaml`(**gitignored,含真实密钥**),模板是 `config.example.yaml`。
- 关键段:`model.primary` / `model.fallback[]` / `model.auxiliary.{embedding,consolidation}` / `scheduler`(唤醒 clamp)/ `agent`(max_turns、session 超时)/ `proactive` / `mcp[]`。
- `auxiliary.embedding` 没配 → 语义检索自动降级为纯 FTS 关键词。

## 人格与风格

- `soul/`(**gitignored**):identity / style / values 的 markdown,是沐的人格定义。
- `soul/style-guard.ts`:`guardStyle` 在回复发给用户前过一遍——去 markdown、去翻译腔。
- `context-assembler.ts` 的 `BEHAVIOR_RULES`:绝对规则(不用 markdown、不说技术术语、不承认是 AI)+ 主动记忆纪律 + 渠道认知(主动找哥哥在 QQ,微信只被动)。

## 部署(xpark 服务器)

xpark = NVIDIA GB10 DGX Spark(ARM64 Ubuntu)。pm2 托管 `mu` / `mu-qq` / `mu-wechat`,`pm2 save` 后开机自启。

改完代码部署:

```bash
# 改了大脑(src/):rsync 后重启 mu(tsx 直跑,不用 build)
rsync -az src/ xpark:/home/xpark/mu/src/ && ssh xpark 'pm2 restart mu'

# 改了 bridge(scripts/*.py):rsync 后重启对应 bridge
rsync -az scripts/qq_bridge.py xpark:/home/xpark/mu/scripts/ && ssh xpark 'pm2 restart mu-qq'
```

> pm2 全路径在非交互 shell 里是 `/home/xpark/.npm-global/bin/pm2`。
