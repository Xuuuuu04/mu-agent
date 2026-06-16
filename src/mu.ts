import { VERSION } from './version.js'
import { resolve } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { loadConfig } from './config.js'
import { AgentLoop } from './core/agent-loop.js'
import { ContextAssembler } from './core/context-assembler.js'
import { Scheduler } from './core/scheduler.js'
import { ModelRouter } from './providers/router.js'
import { ProactiveManager } from './core/proactive.js'
import { log } from './core/logger.js'
import { ToolRegistry } from './tools/registry.js'
import { MemoryStore } from './memory/store.js'
import { MemoryConsolidation } from './memory/consolidation.js'
import { EmbeddingService } from './memory/embedding.js'
import { loadMood } from './memory/layers/mood.js'
import { CLIGateway } from './gateway/cli.js'
import { WebhookGateway } from './gateway/webhook.js'
import { fileReadTool, fileWriteTool, fileListTool } from './tools/builtin/file.js'
import { shellExecTool } from './tools/builtin/shell.js'
import { webFetchTool } from './tools/builtin/web.js'
import { webSearchTool } from './tools/builtin/search.js'
import { messageSendTool } from './tools/builtin/message-send.js'
import { scheduleWakeTool } from './tools/builtin/schedule-wake.js'
import {
  memorySaveTool, memorySearchTool, memoryUpdateTool, memoryForgetTool, knowledgeWriteTool,
  commitmentCreateTool, commitmentDoneTool, streamNoteTool, diaryWriteTool,
} from './tools/builtin/memory-ops.js'
import { toolCreateTool } from './tools/builtin/tool-create.js'
import { voiceSendTool } from './tools/builtin/voice-send.js'
import { HotReloader } from './tools/hot-reload.js'
import { McpManager } from './tools/mcp/manager.js'
import { isCommandText } from './core/commands.js'
import { createDelivery, createSendRouter } from './runtime/delivery.js'
import { MessageQueue } from './runtime/queue.js'

const PROJECT_ROOT = resolve(import.meta.dirname, '..')

async function main() {
  console.log(`沐 (Mu) v${VERSION} 启动中...\n`)

  const config = loadConfig(PROJECT_ROOT)

  for (const dir of [config.paths.data, config.paths.soul, config.paths.tools]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
  log.init(resolve(config.paths.data, 'logs'))
  for (const sub of ['memory', 'knowledge', 'skills', 'tools', 'logs']) {
    const d = resolve(config.paths.data, sub)
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
  }

  const dbPath = resolve(config.paths.data, 'mu.db')
  const store = new MemoryStore(dbPath)
  console.log(`[init] SQLite: ${dbPath} (${store.getEpisodeCount()} episodes)`)

  const embedding = new EmbeddingService(config.model.auxiliary?.embedding)
  console.log(`[init] embedding: ${embedding.available ? config.model.auxiliary?.embedding?.name : '未配置(降级 FTS)'}`)

  const router = new ModelRouter(config)
  console.log(`[init] 模型: ${router.primaryName}`)

  const tools = new ToolRegistry()
  for (const t of [fileReadTool, fileWriteTool, fileListTool, shellExecTool, webFetchTool, webSearchTool,
    messageSendTool, scheduleWakeTool, voiceSendTool,
    memorySaveTool, memorySearchTool, memoryUpdateTool, memoryForgetTool, knowledgeWriteTool,
    commitmentCreateTool, commitmentDoneTool, streamNoteTool, diaryWriteTool, toolCreateTool]) {
    tools.register(t, { reserved: true })
  }
  console.log(`[init] ${tools.size} 个内置工具已注册`)

  const hotReloader = new HotReloader(config.paths.tools, tools)
  hotReloader.start()

  const mcpManager = new McpManager()
  if (config.mcp && config.mcp.length > 0) {
    const n = await mcpManager.loadAll(config.mcp, tools)
    console.log(`[init] MCP: ${n} 个外部工具`)
  }

  const assembler = new ContextAssembler(config, store, embedding)
  assembler.registerTools(tools.toAnthropicTools())

  const scheduler = new Scheduler(config, store)
  // 整合可用便宜模型,没配就用主模型
  const consolidationRouter = config.model.auxiliary?.consolidation
    ? ModelRouter.forProvider(config.model.auxiliary.consolidation)
    : router
  const consolidation = new MemoryConsolidation(store, consolidationRouter, config.paths.data, embedding)

  const loop = new AgentLoop({ config, assembler, router, tools, store, scheduler, consolidation, embedding })
  // cron 兜底据此判断唤醒链断裂(太久没有成功 cycle 就强制唤醒)
  scheduler.setLastSuccessProbe(() => loop.health.lastSuccessAt)

  const proactive = new ProactiveManager(config, config.paths.data)

  const cli = new CLIGateway()
  await cli.connect()
  cli.onClear(() => loop.clearSession())
  cli.onStatus(() => {
    const mood = loadMood(config.paths.data)
    const sched = scheduler.getStatus()
    const lines = [
      `心情: ${mood?.current ?? 'calm'} ${mood?.reason ? `(${mood.reason})` : ''}`,
      `记忆: ${store.getEpisodeCount()} 条`,
    ]
    if (sched.sleeping && sched.nextWake) {
      const secs = Math.round((sched.nextWake.getTime() - Date.now()) / 1000)
      lines.push(`下次自己醒: ${secs}秒后 (${sched.reason})`)
    }
    return lines.join('\n')
  })

  const webDir = resolve(PROJECT_ROOT, 'web')
  const webhook = new WebhookGateway({
    port: config.webhook?.port ?? 3210,
    store,
    webDir,
    soulDir: config.paths.soul,
    dataDir: config.paths.data,
    configPath: resolve(PROJECT_ROOT, 'config', 'config.yaml'),
    logDir: resolve(config.paths.data, 'logs'),
    getTools: () => tools.list(),
    getAgentHealth: () => {
      const h = loop.health
      const sched = scheduler.getStatus()
      return {
        last_success_at: h.lastSuccessAt?.toISOString() ?? null,
        consecutive_failures: h.consecutiveFailures,
        next_wake_at: sched.sleeping && sched.nextWake ? sched.nextWake.toISOString() : null,
        next_wake_reason: sched.sleeping ? sched.reason : null,
      }
    },
  })
  await webhook.connect()
  webhook.onMessage((msg) => {
    // 命令消息(/status 这类)是发给系统的查询,不是哥哥来说话:
    // 不打断她的闹钟(打断后命令路径不会重设,唤醒链会断),也不算一次互动
    const isCmd = msg.content.type === 'text' && isCommandText(msg.content.text)
    if (!isCmd) {
      proactive.onUserMessage()
      scheduler.interruptForMessage()
    }
    messageQueue.push({ type: 'message', message: msg })
  })
  // 外部事件:手动唤醒 / 系统报警等
  webhook.onEvent((event) => {
    scheduler.interruptForMessage()
    if (event === 'manual_wake') {
      messageQueue.push({ type: 'manual', reason: '手动唤醒' })
    } else {
      messageQueue.push({ type: 'system_event', event })
    }
  })

  // 微信被动应答走 Python bridge(wechat_bridge.py)：bridge POST /webhook/message 拿同步 response，
  // 不在大脑进程里跑微信网关。早期 WeChatFerry 路线(ferry.ts/clawbot.ts)已移除。

  // 哥哥的主动消息通道 —— 走 QQ(沐主动找哥哥发到 QQ)。
  // 微信只做被动应答(哥哥发、沐回),不主动推:iLink 主动推送有 stale-token 硬限制,
  // 而 QQ 官方 bot 的 C2C 主动私信原生支持,所以主动一律走 QQ bridge。
  const qqSendUrl = config.qq?.bridge_send_url ?? 'http://127.0.0.1:3212/send'
  const delivery = createDelivery(qqSendUrl, webhook)

  // 运维告警:agent-loop 连续失败自愈时直接 POST QQ bridge 通知哥哥。
  // 不走 LLM(模型全挂时才需要它)、不走 deliverToUser(那条路失败会塞 outbox 当成她的话)
  loop.setOpsAlert(text => delivery.postToQQ(text))

  // message_send / 主动消息的发送路由(cli / autonomous / webhook追发 / 其他进 outbox)
  loop.setSendRouter(createSendRouter({
    cli,
    recordSent: () => proactive.recordSent(),
    pushOutbox: text => webhook.pushOutbox(text),
    deliverToUser: delivery.deliverToUser,
  }))

  // 队列:串行处理触发,合并连发,跑 cycle,按来源+同步窗口分发回复(含防蒸发转主动推)
  const messageQueue = new MessageQueue({
    loop, webhook, cli, scheduler, deliverToUser: delivery.deliverToUser,
  })

  scheduler.setWakeHandler((trigger) => messageQueue.push(trigger))

  cli.onMessage((msg) => {
    const isCmd = msg.content.type === 'text' && isCommandText(msg.content.text)
    if (!isCmd) {
      proactive.onUserMessage()
      scheduler.interruptForMessage()
    }
    messageQueue.push({ type: 'message', message: msg })
  })

  // 主动通信:满足条件就塞一个 system_event 触发,让沐自己决定要不要找哥哥
  proactive.setTrigger((trigger) => messageQueue.push(trigger))
  proactive.start()

  loop.restoreSession()     // 重启前落盘的会话接回来,部署不再丢她的短期记忆
  scheduler.startCronFallback()
  scheduler.restoreWake()   // 重启前落盘的闹钟接回来,部署不再偷走她的睡醒
  cli.startInteractive()

  const shutdown = () => {
    console.log('\n[shutdown] 正在关闭...')
    hotReloader.stop()
    scheduler.stop()
    proactive.stop()
    mcpManager.stopAll()
    store.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error('启动失败:', err)
  process.exit(1)
})
