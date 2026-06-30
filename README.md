# Shion — 自托管专业个人助理

Shion 是运行在个人服务器上的专业 AI 助理：能持续记忆、使用工具、跟进多步骤任务，并通过 QQ、微信、CLI 和 Web 工作台交互。

项目保留了 Mu/Hermes 时代的数据目录与进程名以兼容已有部署，但产品身份、行为规则和界面统一为 Shion。

## 核心能力

- **任务跟进**：Task 状态机、DoD、自审、失败退避与有界自主续跑。
- **子代理编排**：隔离的 worker/reviewer，支持受限工具、并行 fan-out、超时取消和成本上限。
- **持久记忆**：事实、会话、情景、技能和知识；SQLite FTS、向量检索与 IMA 知识库互补。
- **多模型路由**：Anthropic/OpenAI 两类协议、fallback、限流冷却、消息清洗和工具 schema 兼容。
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

架构细节见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，当前规格见 [REQUIREMENTS.md](REQUIREMENTS.md)。
