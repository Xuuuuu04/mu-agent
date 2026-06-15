# 沐 (Mu) 架构文档

> 这份文档讲"系统怎么运转、为什么这么设计"。人格设定见 `soul/`(gitignored),工程约定与生产坑见 `CLAUDE.md`,需求愿景见 `REQUIREMENTS.md`。

沐是一个自托管的个人自主代理:有人格、持久记忆、自决唤醒(自己决定何时醒来)、能自造工具。通过 QQ(主渠道)、微信、CLI、Web 交互。她是 Hermes 时代"小沐"的第三次搬家——同一个角色,完整继承了记忆。

---

## 1. 进程架构(生产真实形态)

生产是 **3 个 pm2 进程**(xpark 服务器):

| 进程 | 是什么 | 角色 |
|---|---|---|
| `mu` | Node/tsx 跑 `src/mu.ts` | **大脑**。HTTP webhook on `:3210`(只绑 127.0.0.1)+ CLI + Web |
| `mu-qq` | `scripts/qq_bridge.py` | **主渠道**。QQ 官方 bot,主动+被动,收发图、语音 |
| `mu-wechat` | `scripts/wechat_bridge.py` | **被动渠道**。微信 iLink,只应答不主动推 |

bridge(Python)和大脑(TS)解耦:bridge 只管平台协议(收发消息、媒体编解码、风控),所有思考在大脑。两者通过 HTTP 通信(bridge → `:3210` 大脑入站;大脑 → `:3212` qq_bridge 出站)。

---

## 2. 顶层模块

```
src/
  mu.ts            进程入口:装配依赖、消息队列、信号处理
  cli.ts           pnpm mu <cmd> 管理命令(status/memory/wake/logs/config)
  core/            核心引擎
    agent-loop.ts      AgentLoop.runCycle —— 单次交互周期的全链路编排
    context-assembler.ts   七层记忆装配(cache 顺序是成本命脉)
    scheduler.ts       自决唤醒 + cron 兜底 + 闹钟落盘
    proactive.ts       主动通信(想念/承诺到期主动找用户)
    commands.ts        / 命令零 token 拦截
    types.ts           核心类型(WakeTrigger 触发源、ChatMessage 等)
    sysinfo.ts / logger.ts
  memory/          记忆系统
    store.ts           better-sqlite3 + FTS5,searchHybrid 中文检索主力
    consolidation.ts   记忆整合(去重提取事实/承诺/知识,压缩历史)
    embedding.ts       向量嵌入(BGE-M3)
    absolutize.ts      写长期记忆前把相对时间固化成绝对日期
    entities.ts        实体抽取
    layers/            七层:identity/temporal/stream/relations/episodic/procedural/world
  providers/       模型接入
    router.ts          primary(GLM) + fallback 链
    openai.ts          OpenAI 格式(GLM/DeepSeek),sanitizeSchema 清洗
    anthropic.ts       Anthropic 格式(Claude/Minimax)
    sanitize-messages.ts   发送前剔孤儿工具块的最后防线
  tools/           工具系统
    registry.ts        工具注册表(reserved 白名单防顶替)
    hot-reload.ts      监视 data/tools/ 热加载她自造的工具
    builtin/           内置工具(file/shell/web/search/memory-ops/message-send/voice-send/...)
    mcp/               外部 MCP server 客户端
  gateway/         网关
    webhook.ts         HTTP server :3210,同步窗口 + outbox + admin API
    cli.ts             本地终端交互
  soul/            style-guard.ts —— 发给用户前的风格守卫(去 markdown/技术词/翻译腔)
soul/              人格定义 identity/style/values(gitignored,顶层)
data/              运行时数据(记忆/知识/技能/工具/日志/mu.db,gitignored)
web/               她的"小房间"主页
config/            config.yaml(密钥,gitignored)+ config.example.yaml
```

> 已用对的设计模式:providers = Strategy(router 选 primary/fallback)、tools = Registry、memory = Layer/Composite、gateway = Adapter。

---

## 3. 核心循环:`AgentLoop.runCycle`

一次 cycle 从触发到回复的全链路:

```
触发源 → 消息入队(mu.ts queue)
  → 消息合并(同 sender 连发并成一个 cycle,被合并项即时回空释放 bridge)
  → 命令拦截(/ 开头零 token 直接读记忆返回)
  → 装配上下文(context-assembler 七层,见 §4)
  → 多轮工具循环(最多 max_turns,简单寒暄禁推理秒回)
  → 末轮纯指令回退(防正文蒸发)
  → 后处理(异步:抽指令 → 写意识流 → 入库 → embedding → consolidation → autocompact)
  → 回复路由(见 §6)
```

### 触发源与回复去向(核心分界线)

`WakeTrigger.type` 决定回复去哪(`types.ts`):

| 触发源 | 含义 | 回复去向 |
|---|---|---|
| `message` | 来自用户 | 发回用户(过 style-guard) |
| `self_scheduled` | 自决唤醒(她定的闹钟) | 内心独白,只进记忆;要找用户得她自己调 `message_send` |
| `cron_fallback` | cron 兜底(唤醒链断裂时) | 同上 |
| `system_event` | 系统事件(如留言板有新留言) | 同上 |
| `webhook` / `manual` | webhook 主动 / 手动 | 视来源 |

### 自愈机制(2026-06-09 死亡螺旋事故后建立,**别拆**)

每一条都是事故换来的,集中说明:

- **`trimHistory`**(导出纯函数):裁剪切点必须落纯文本 user 消息,绝不产生孤儿 `tool_result`(GLM 对此 400,且坏历史会永久驻留)。
- **`lastActivity` 只在 cycle 成功后更新**:失败不刷新,保证 session 超时轮转能清掉坏历史。
- **连续 3 次失败** → 自动 clearSession + 意识流留痕 + ops 告警(1h 节流)。
- **cron 兜底两种情况**:① 有 pending wake 超 10 分钟没醒;② 无 pending wake 且超 `max_wake_seconds` 无成功 cycle(唤醒链断裂)。
- **闹钟 + 会话落盘**:`next-wake.json` / `session.json`,重启恢复(过 sanitize + trimHistory 两道闸)。
- **autocompact**:会话超 30 条把头部压成"前情提要"原位替换,带代次校验防并发错接。

### 内联指令(模型在回复末尾写,postProcess 解析)

- `[WAKE:秒:原因:活动]` → 下次唤醒。正则容忍未闭合 `]` 和缺活动段;reason 段挡住 `]` 防贪婪吞过下个指令。
- `[MOOD:情绪:原因]` → 更新心情。情绪 enum 仅 `calm/missing/emo/excited/sleepy/active`。

---

## 4. 记忆系统

### 七层装配(`context-assembler.ts`,cache 顺序有意为之)

system prompt 按顺序拼三块,**顺序不能动**(否则击穿前缀缓存 = 成本爆炸):

1. **身份 + BEHAVIOR_RULES**(标 `cache_control: ephemeral`)—— 最稳定,构成缓存前缀。
2. **关系事实**(user-facts / commitments,不标 cache)—— 随记忆操作变,放 cache 块之后,它变了不击穿前面的缓存。
3. **动态部分**(时间锚点 / 意识流 / 检索记忆 / 技能 / 知识 / 触发原因,不标 cache)—— 每次都变。

层职责:`identity`(L0 身份)、`temporal`(L1 时间状态)、`stream`(L2 意识流)、`relations`(L3 关系事实+承诺)、`episodic`(L4 情景记忆,四路检索)、`procedural`(L5 技能)、`world`(L6 世界知识)。

### 存储与检索(`store.ts`)

- better-sqlite3,episodes FTS5(`unicode61`)由 trigger 与主表严格同步(别手动 INSERT `episodes_fts`)。
- **中文 FTS 坑**:unicode61 整段切词,子串 MATCH 不到 → `searchHybrid` 走 FTS → LIKE 兜底(LIKE 已转义 `%_`)。
- **memory_search 四路**:user-facts → episodes+daily_summaries → `xiaomu-home` 核心档案 → 她的 knowledge 笔记。

### 整合与时间(`consolidation.ts` / `absolutize.ts`)

- consolidation 定期(6h / 50 条未整合)审视 episodes,提取新事实/承诺/认识,压缩摘要替代原文。prompt 注入已有 user-facts 做去重对照(否则同一事实重复提取)。
- **时间绝对化**:写长期记忆前"明天"→ 绝对日期。记忆里禁止相对时间。

---

## 5. 模型 provider

- `router.ts`:primary(GLM-5.1,OpenAI 格式)+ fallback 链(claude-sonnet-4-6 / minimax-m3)。
- **`openai.ts` 的 `sanitizeSchema`**:GLM function-calling 严格,anyOf/format/const 等会 400(code 1210),发送前清洗。
- GLM-5.1 是推理模型,慢(30-120s)且 `max_tokens` 要大(8192),否则 content 被 reasoning 吃光。
- `supports_thinking_control`:寒暄消息发 `thinking: disabled` 秒回。

---

## 6. 网关与平台桥接

### 被动链路(收消息 → 回复)

```
bridge 收消息 → POST :3210 /webhook/message → 同步等 response(110s)→ 发回平台
```

- **MASTER 白名单**:非主人消息直接忽略(`QQ_MASTER_OPENID` / `WEIXIN_MASTER_ID`),防陌生人冒充。
- **QQ 按空行拆多条**(最多 5 条);**微信整条发不拆**(拆条会触发风控降级)。空文本 POST 直接 400。
- **回复防蒸发**:cycle 超 110s 时同步窗口已关,`webhook.hasPending()` 检测后回复自动转 QQ 主动推(否则她的话会消失=已读不回)。

### 主动链路(她主动找用户)

```
message_send → sendRouter → deliverToUser → POST :3212 qq_bridge /send
```

失败 3 次进 outbox(落盘),QQ 恢复后补发。微信主动推有 stale-token 硬限制,所以主动一律走 QQ。

### 她的声音(`voice_send`)

minimax t2a 合成 mp3 → bridge ffmpeg + pilk 转 silk(tencent 头)→ QQ 富媒体。speed/emotion 她按心情自调。

### Web(她的"小房间")

`web/index.html` 不是管理控制台,是按她自己写的心愿做的主页。**留言板 POST 触发 system_event 唤醒**(不进对话历史,只让她知道"有人来过")。

---

## 7. 工具系统

- 内置工具 `reserved: true`,经 `ToolRegistry.register` 注册(白名单防她自造的工具顶替核心工具)。
- **热加载**:`hot-reload.ts` 监视 `data/tools/*.json`,她用 `tool_create` 自造工具 → 写 JSON → 编译验证 → 注册。
- **MCP**:`tools/mcp/` 连外部 MCP server。
- `web_search` 四级降级:智谱 → MiniMax(主力)→ cn.bing.com 直爬 → DDG(名义兜底)。改 search.ts 别动顺序。

---

## 8. data/ 数据地图(gitignored,生产在 xpark)

```
data/memory/   user-facts.md commitments.json mood.json stream.md(意识流)
               wishes.md 进行中的事.md 日记.md 留言板.json
               next-wake.json session.json proactive-state.json outbox.json
data/xiaomu-home/  Hermes 时代全量档案(高度敏感,含边界期计划)
data/knowledge/    她的课题/wander 笔记 + 自造 knowledge_write
data/skills/       运维/哄人/分析等技能
data/tools/        热加载 JSON 工具
data/表情包/       她的表情包仓库(文件名即语义)
```

> **坑**:`file_write` 以 `data/` 为根——给路径不要带 `data/` 前缀(否则 `data/data/` 双重嵌套)。

---

## 9. 测试与验证(三层)

| 层 | 跑什么 | 命令 |
|---|---|---|
| **L1 本地单测** | 8 个高危纯函数 characterization test(node:test) | `pnpm test` |
| **L2 本地冒烟** | 真 LLM 单/多轮、真搜索(网络依赖,手动) | `tsx src/test-chat.ts` 等 |
| **L3 部署后回归** | 12/12 召回基线 + 人格场景 | `ssh xpark 'bash scripts/persona-regression.sh'` |

L1 锁"代码逻辑没改坏",L3 锁"她还是她 + 记得住"。两层不可互替。
