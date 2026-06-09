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
import { HotReloader } from './tools/hot-reload.js'
import { McpManager } from './tools/mcp/manager.js'
import { guardStyle } from './soul/style-guard.js'
import type { WakeTrigger } from './core/types.js'

const PROJECT_ROOT = resolve(import.meta.dirname, '..')

async function main() {
  console.log('沐 (Mu) v0.2.0 启动中...\n')

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
    messageSendTool, scheduleWakeTool,
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
  const consolidation = new MemoryConsolidation(store, consolidationRouter, config.paths.data)

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
    proactive.onUserMessage()
    scheduler.interruptForMessage()
    queue.push({ type: 'message', message: msg })
    processQueue()
  })
  // 外部事件:手动唤醒 / 系统报警等
  webhook.onEvent((event) => {
    scheduler.interruptForMessage()
    if (event === 'manual_wake') {
      queue.push({ type: 'manual', reason: '手动唤醒' })
    } else {
      queue.push({ type: 'system_event', event })
    }
    processQueue()
  })

  // 微信被动应答走 Python bridge(wechat_bridge.py)：bridge POST /webhook/message 拿同步 response，
  // 不在大脑进程里跑微信网关。早期 WeChatFerry 路线(ferry.ts/clawbot.ts)已移除。

  // 哥哥的主动消息通道 —— 走 QQ(沐主动找哥哥发到 QQ)。
  // 微信只做被动应答(哥哥发、沐回),不主动推:iLink 主动推送有 stale-token 硬限制,
  // 而 QQ 官方 bot 的 C2C 主动私信原生支持,所以主动一律走 QQ bridge。
  const qqSendUrl = config.qq?.bridge_send_url ?? 'http://127.0.0.1:3212/send'
  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

  // 只负责把一条消息 POST 到 QQ bridge，失败抛错(不兜底)，供 deliverToUser/drainOutbox 复用
  const postToQQ = async (text: string): Promise<void> => {
    const r = await fetch(qqSendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(15000),
    })
    const d = await r.json().catch(() => ({})) as { ok?: boolean; error?: string }
    if (!r.ok || !d.ok) throw new Error(d.error ?? `HTTP ${r.status}`)
  }

  // QQ 恢复后把积压的 outbox 逐条补发；某条再失败就塞回并停手(QQ 还没好)
  const drainOutbox = async (): Promise<void> => {
    for (const item of webhook.takeOutbox()) {
      try {
        await postToQQ(item.text)
        console.log(`  [outbox] 补发成功: ${item.text.slice(0, 30)}`)
      } catch {
        webhook.pushOutbox(item.text)
        break
      }
    }
  }

  const deliverToUser = async (text: string): Promise<void> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await postToQQ(text)
        console.log(`  [deliver] 主动消息已发 QQ`)
        await drainOutbox()   // 这次通了，顺手把之前积压的也补发掉
        return
      } catch (e) {
        if (attempt < 2) { await sleep(500 * 2 ** attempt); continue }
        webhook.pushOutbox(text)
        console.error(`[deliver] QQ 主动发送失败 3 次,转 outbox: ${(e as Error).message}`)
      }
    }
  }

  // message_send / 主动消息的发送路由
  loop.setSendRouter(async (source, text) => {
    if (source === 'cli') {
      await cli.send({ target: { source: 'cli', chat_id: 'local' }, content: [{ type: 'text', text }] })
      return
    }
    if (source === 'autonomous') {
      proactive.recordSent()
      console.log(`\n沐(主动): ${text}\n`)
      await deliverToUser(text)
    } else if (source === 'webhook') {
      // QQ 对话中途沐又多说的一条：必须走 QQ 主动推，否则塞进 web-only outbox 用户根本看不到
      console.log(`\n沐(追发): ${text}\n`)
      await deliverToUser(text)
    } else {
      // 其他来源(微信 iLink 主动推有 stale-token 硬限制)只能进 outbox 兜底
      webhook.pushOutbox(text)
    }
  })

  let processing = false
  const queue: WakeTrigger[] = []

  // 哥哥连发的几条消息合并进一个 cycle,避免逐条全量回应(重逢戏码三连发的预防针)。
  // 被合并的消息立刻回空响应,释放 bridge 的同步等待(不然它干等 110s)。
  const mergeQueuedMessages = async (trigger: WakeTrigger): Promise<void> => {
    if (trigger.type !== 'message' || trigger.message.content.type !== 'text') return
    const extra: string[] = []
    while (queue.length > 0) {
      const next = queue[0]!
      if (next.type !== 'message'
        || next.message.sender.id !== trigger.message.sender.id
        || next.message.content.type !== 'text') break
      queue.shift()
      extra.push(next.message.content.text)
      if (next.message.source === 'webhook') {
        await webhook.send({
          target: { source: 'webhook', chat_id: next.message.sender.id },
          content: [{ type: 'text', text: '' }],
          reply_to: next.message.id,
        })
      }
    }
    if (extra.length > 0) {
      trigger.message.content.text += '\n' + extra.join('\n')
      console.log(`  [queue] 合并了 ${extra.length} 条连发消息`)
    }
  }

  const processQueue = async () => {
    if (processing || queue.length === 0) return
    processing = true

    const trigger = queue.shift()!
    try {
      await mergeQueuedMessages(trigger)
      const result = await loop.runCycle(trigger)

      // 只有"消息触发"的 cycle 才把回复发给用户(这是在回他的话)。
      // 自主唤醒/主动触发的 cycle,回复是内心活动,只进意识流/记忆;要找哥哥得 agent 自己调 message_send。
      if (result.response && trigger.type === 'message') {
        const { cleaned, issues } = guardStyle(result.response)
        if (issues.length > 0) {
          const fixed = issues.filter(i => i.fixed).length
          if (fixed > 0) console.log(`  [style] 修正了 ${fixed} 个风格问题`)
        }
        const outMsg = {
          target: { source: trigger.message.source, chat_id: trigger.message.sender.id },
          content: [{ type: 'text' as const, text: cleaned }],
          reply_to: trigger.message.id,
        }

        if (trigger.message.source === 'webhook') {
          await webhook.send(outMsg)
        } else {
          await cli.send(outMsg)
        }
      } else if (result.response) {
        // 自主 cycle 的内心独白,dev 下打印看看
        console.log(`  [内心] ${result.response.slice(0, 60)}`)
      } else if (trigger.type === 'message') {
        // 回复为空(reasoning 吃光 token/只调了工具/清洗后空)：仍要释放同步等待的 bridge，
        // 否则它干等 110s 表现成"已读不回"。发空文本即可，bridge 端 if not reply 会自行忽略。
        const src = trigger.message.source
        const emptyMsg = {
          target: { source: src, chat_id: trigger.message.sender.id },
          content: [{ type: 'text' as const, text: '' }],
          reply_to: trigger.message.id,
        }
        if (src === 'webhook') await webhook.send(emptyMsg)
      }

      const tok = result.tokens_used
      const cache = tok.cache_read ? ` cache:${tok.cache_read}` : ''
      log.info('cycle', `${tok.input}+${tok.output}tok${cache} ${result.tool_calls_made}tools ${result.duration_ms}ms`, {
        trigger: trigger.type, input: tok.input, output: tok.output, cache_read: tok.cache_read ?? 0,
        tools: result.tool_calls_made, ms: result.duration_ms,
      })

      const schedStatus = scheduler.getStatus()
      if (schedStatus.sleeping && schedStatus.nextWake) {
        const secs = Math.round((schedStatus.nextWake.getTime() - Date.now()) / 1000)
        console.log(`  [scheduler] 下次醒来: ${secs}秒后 (${schedStatus.reason})`)
      }
    } catch (err) {
      log.error('cycle', (err as Error).message, { trigger: trigger.type })
    } finally {
      processing = false
      if (queue.length > 0) processQueue()
    }
  }

  scheduler.setWakeHandler((trigger) => {
    queue.push(trigger)
    processQueue()
  })

  cli.onMessage((msg) => {
    proactive.onUserMessage()
    scheduler.interruptForMessage()
    queue.push({ type: 'message', message: msg })
    processQueue()
  })

  // 主动通信:满足条件就塞一个 system_event 触发,让沐自己决定要不要找哥哥
  proactive.setTrigger((trigger) => {
    queue.push(trigger)
    processQueue()
  })
  proactive.start()

  scheduler.startCronFallback()
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
