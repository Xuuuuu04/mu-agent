import { VERSION } from './version.js'
import { resolve } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { loadConfig } from './config.js'
import { AgentLoop } from './core/agent-loop.js'
import { ContextAssembler } from './core/context-assembler.js'
import { Scheduler } from './core/scheduler.js'
import { ModelRouter } from './providers/router.js'
import { ProactiveManager } from './core/proactive.js'
import { WatchdogManager, parseIfindPrices } from './core/watchdog.js'
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
  portfolioAddTool, portfolioUpdateTool, portfolioRemoveTool,
} from './tools/builtin/memory-ops.js'
import { toolCreateTool } from './tools/builtin/tool-create.js'
import { voiceSendTool } from './tools/builtin/voice-send.js'
import { imageGenTool } from './tools/builtin/image-gen.js'
import { downloadImageTool } from './tools/builtin/download-image.js'
import {
  investmentCaseListTool, investmentCaseUpsertTool, investmentEvidenceAppendTool,
  investmentDecisionListTool, investmentDecisionRecordTool, portfolioRiskAnalyzeTool,
  aStockBacktestTool, mxAnalyzeTool,
} from './tools/builtin/finance/index.js'
import {
  taskCreateTool, taskListTool, taskUpdateTool, taskReviewTool, taskDeleteTool,
} from './tools/builtin/task.js'
import { spawnSubagentTool, spawnParallelTool, bindRegistry as bindSubagentRegistry } from './tools/builtin/spawn-subagent.js'
import { HotReloader } from './tools/hot-reload.js'
import { McpManager } from './tools/mcp/manager.js'
import { isCommandText } from './core/commands.js'
import { createDelivery, createSendRouter } from './runtime/delivery.js'
import { MessageQueue } from './runtime/queue.js'

const PROJECT_ROOT = resolve(import.meta.dirname, '..')

async function main() {
  console.log(`Shion v${VERSION} 启动中...\n`)

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
    messageSendTool, scheduleWakeTool, voiceSendTool, imageGenTool, downloadImageTool,
    memorySaveTool, memorySearchTool, memoryUpdateTool, memoryForgetTool, knowledgeWriteTool,
    commitmentCreateTool, commitmentDoneTool, streamNoteTool, diaryWriteTool, toolCreateTool,
    portfolioAddTool, portfolioUpdateTool, portfolioRemoveTool,
    investmentCaseListTool, investmentCaseUpsertTool, investmentEvidenceAppendTool,
    investmentDecisionListTool, investmentDecisionRecordTool, portfolioRiskAnalyzeTool,
    aStockBacktestTool, mxAnalyzeTool,
    taskCreateTool, taskListTool, taskUpdateTool, taskReviewTool, taskDeleteTool,
    spawnSubagentTool, spawnParallelTool]) {
    tools.register(t, { reserved: true })
  }
  // spawn_subagent/spawn_parallel 要 registry 引用做 subsetFor(子代理工具子集),后绑定而非塞进 ToolContext(保持 ctx 干净)
  bindSubagentRegistry(tools)
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
  // cron 兜底据此判断唤醒链断裂(太久没有成功 cycle 就强制唤醒,无条件,不依赖有没有待办)
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
        router_health: router.getHealthSnapshot(),
        scheduler_calendar_health: scheduler.getCalendarHealthSnapshot(),
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
  // 主动消息投递渠道:微信优先(配置了 wechat.bridge_send_url 就走微信 bridge /send),否则 QQ bridge。
  const channelSendUrl = config.wechat?.bridge_send_url ?? config.qq?.bridge_send_url ?? 'http://127.0.0.1:3212/send'
  const delivery = createDelivery(channelSendUrl, webhook)

  // A 股盯盘 watchdog:盘中定时查持仓现价,触止损/止盈主动告警(确定性,不烧 LLM)。
  // 取价走 iFind stock_highfreq_quotes(structured real_time);未接 iFind 则取不到价、静默跳过。
  const aStock = config.scheduler.a_stock
  const watchdogCfg = aStock?.watchdog
  const watchdog = new WatchdogManager({
    dataDir: config.paths.data,
    deliverToUser: delivery.deliverToUser,
    calendarPath: aStock?.calendar_path,
    intervalSec: watchdogCfg?.interval_seconds,
    nearPct: watchdogCfg?.near_pct,
    fetchPrices: async (codes) => {
      const tool = tools.get('hexin-ifind-stock__stock_highfreq_quotes')
      if (!tool) return new Map()
      const r = await tool.execute(
        { symbols: codes.join(','), data_mode: 'real_time', indicators: '最新价' },
        { config, dataDir: config.paths.data, log: () => {} } as never,
      )
      return parseIfindPrices(r.output)
    },
  })

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

  // A 股 watchdog(开关在 config.scheduler.a_stock.watchdog.enabled)。盘中触发线告警走 delivery(微信)。
  if (watchdogCfg?.enabled) watchdog.start()

  loop.restoreSession()     // 重启前落盘的会话接回来,部署不再丢她的短期记忆
  scheduler.startCronFallback()
  scheduler.restoreWake()   // 重启前落盘的闹钟接回来,部署不再偷走她的睡醒
  cli.startInteractive()

  // outbox 定期补发:drainOutbox 原本只在她主动发消息成功后顺带触发,若她长时间只在同步窗口
  // 应答(不主动推),QQ 恢复后的积压会一直躺着。5 分钟兜底扫一次(空队列 take 不写盘,无 churn)。
  const outboxDrainTimer = setInterval(() => {
    delivery.drainOutbox().catch(e => console.error(`[outbox] 定期补发失败: ${(e as Error).message}`))
  }, 5 * 60_000)
  outboxDrainTimer.unref?.()

  const shutdown = () => {
    console.log('\n[shutdown] 正在关闭...')
    clearInterval(outboxDrainTimer)
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
