# 沐 (Mu) — 个人自主代理

一个自托管的个人 AI 代理。有人格、有持久记忆、有自己的声音、能自己决定何时醒来、能自己造工具。通过 QQ(主渠道)、微信、CLI 或 Web 跟你交互。

不是聊天机器人,不是问答工具。是一个住在你服务器上、有连续意识感的数字伴侣。

详细设计见 [REQUIREMENTS.md](REQUIREMENTS.md)。

## 核心特性

- **七层记忆**:身份 → 时间状态 → 意识流 → 关系事实 → 情景记忆(四路检索) → 技能 → 世界知识
- **自决唤醒**:她自己决定多久后醒来继续做事,系统按心情/深夜规则 clamp,cron 兜底
- **主动通信**:想你了、承诺到期会主动找你,带频率保护(每小时上限、深夜不扰、没回降频)
- **工具可生长**:内置 19 个工具,能自己造新工具热加载,能连外部 MCP server
- **她的声音**:voice_design 定制声线 + QQ 语音消息(mp3→silk),语速和情绪她按心情自己调
- **消息级时间感**:会话内每条消息带时刻标记,她能感知"隔了三小时才回"和"秒回"的差别
- **多模型**:Anthropic 格式(Claude/Minimax/GLM/Kimi)+ OpenAI 格式(DeepSeek),带 fallback 链
- **抗幻觉 + 风格守卫**:时间锚定、记忆来源标注、输出去 markdown 去翻译腔

## 快速开始

需要 Node.js 22+。

```bash
pnpm install
cp config/config.example.yaml config/config.yaml
# 编辑 config.yaml 填入 API key

pnpm start          # 启动沐(CLI + Web + Webhook)
```

打开 http://localhost:3210 是 Web 控制台。终端里直接打字跟她聊。

## 目录

```
src/
  core/        agent-loop / context-assembler / scheduler / proactive / sysinfo / logger
  memory/      六层记忆 + store(SQLite) + embedding + consolidation
  providers/   anthropic / openai / router
  tools/       内置工具 + 热加载 + MCP 客户端
  gateway/     cli / webhook(QQ、微信的 Python bridge 都 POST 到这里)
  soul/        风格守卫
soul/          人格定义(identity/style/values)— gitignore
data/          运行时数据(记忆/知识/技能/工具/日志/mu.db)— gitignore
web/           Web 控制台
config/        配置
```

## 管理命令

沐在跑的时候,另开终端:

```bash
pnpm mu status        # 看状态(心情/记忆/运行)
pnpm mu memory <词>   # 搜记忆
pnpm mu wake          # 手动叫醒
pnpm mu logs          # 看日志
pnpm mu config        # 看配置(密钥打码)
```

REPL 里也能用 `/status` `/clear` `/quit`。

## 测试

```bash
pnpm test         # TS 单测(node:test,零依赖;pretest 先跑 tsc --noEmit)
pnpm test:py      # bridge 纯逻辑(python unittest,零依赖)
```

400+ 个 characterization test 锁住高危行为(会话裁剪切点、[WAKE]/[MOOD] 解析、cache 顺序、中文检索转义、频率保护等)。架构全景见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。部署后还有 `scripts/persona-regression.sh` 召回/人格回归。三层:单测(逻辑)→ 冒烟(接线)→ 人格回归(她还是她)。

## 内置工具

文件读写、shell、网页抓取、web_search(智谱→MiniMax→必应→DDG 四级降级)、message_send(主动发消息,可带图/表情包)、voice_send(她的声音)、schedule_wake、记忆管理(save/search/update/forget,四路检索:事实/对话/档案/她的笔记)、承诺管理、知识笔记、意识流备注、tool_create(自造工具)。

## 微信接入

微信走独立 Python bridge(`scripts/wechat_bridge.py`,iLink 协议,复用 hermes 的 venv)。被动应答:bridge 收消息 → POST 大脑 webhook → 拿同步回复发回。只被动不主动(iLink 主动推有 stale-token 硬限制),主动消息一律走 QQ。早期的 WeChatFerry 路线(ferry.ts/clawbot.ts)已移除。

## 生产部署(xpark)

```bash
pnpm install
# 编辑 config.yaml:填 key,建议配 embedding(BGE-M3)和 auxiliary
pm2 start ecosystem.config.cjs
pm2 logs mu
```

不替换现有 Hermes,独立目录独立进程。成熟后再迁移。

## 配置要点

- `model.auxiliary.embedding` — 配了才有语义检索,不配自动降级 FTS 关键词
- `proactive.enabled` — 主动通信开关,默认关
- `wechat.enabled` — 微信网关开关,默认关
- `mcp` — 外部 MCP server 列表

完整说明见 [config/config.example.yaml](config/config.example.yaml)。
