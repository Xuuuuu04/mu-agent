import type { MuConfig, WakeTrigger, ChatMessage, ContentBlock, CycleResult } from './types.js'
import { ContextAssembler } from './context-assembler.js'
import { ModelRouter } from '../providers/router.js'
import { ToolRegistry } from '../tools/registry.js'
import type { MemoryStore } from '../memory/store.js'
import type { Scheduler } from './scheduler.js'
import type { MemoryConsolidation } from '../memory/consolidation.js'
import { EmbeddingService } from '../memory/embedding.js'
import { extractEntities } from '../memory/entities.js'
import { updateMood } from '../memory/layers/mood.js'
import { guardStyle } from '../soul/style-guard.js'
import { log } from './logger.js'
import { tryCommand } from './commands.js'

export class AgentLoop {
  private config: MuConfig
  private assembler: ContextAssembler
  private router: ModelRouter
  private tools: ToolRegistry
  private store: MemoryStore | null
  private scheduler: Scheduler | null
  private consolidation: MemoryConsolidation | null
  private embedding: EmbeddingService | null
  private sessionHistory: ChatMessage[] = []
  private sessionId: string
  private running = false
  private lastActivity = Date.now()
  private lastSuccessAt: Date | null = null
  private consecutiveFailures = 0
  private compacting = false
  private sendRouter: ((source: string, text: string, imagePath?: string) => Promise<void>) | null = null

  constructor(opts: {
    config: MuConfig
    assembler: ContextAssembler
    router: ModelRouter
    tools: ToolRegistry
    store?: MemoryStore
    scheduler?: Scheduler
    consolidation?: MemoryConsolidation
    embedding?: EmbeddingService | null
  }) {
    this.config = opts.config
    this.assembler = opts.assembler
    this.router = opts.router
    this.tools = opts.tools
    this.store = opts.store ?? null
    this.scheduler = opts.scheduler ?? null
    this.consolidation = opts.consolidation ?? null
    this.embedding = opts.embedding ?? null
    this.sessionId = `s_${Date.now().toString(36)}`
  }

  async runCycle(trigger: WakeTrigger): Promise<CycleResult> {
    if (this.running) {
      throw new Error('cycle already running')
    }
    this.running = true
    const start = Date.now()
    let totalInput = 0
    let totalOutput = 0
    let totalCacheRead = 0
    let toolCallCount = 0

    // 距上次活动超过 session 超时,先归档旧会话(生成摘要)再开新的。
    // lastActivity 只在 cycle 成功后更新(见 try 末尾)——失败的 cycle 不算活动,
    // 否则坏历史导致的反复失败会一直刷新计时,session 永不轮转,坏历史永生(06-09 事故)。
    this.maybeRotateSession()

    try {
      const currentInput = trigger.type === 'message' && trigger.message.content.type === 'text'
        ? trigger.message.content.text
        : undefined

      // 命令拦截:/ 开头的直接读记忆系统返回,不装配上下文、不存记忆、不走 LLM
      if (currentInput && this.store && this.scheduler) {
        const cmdResult = tryCommand(currentInput, {
          dataDir: this.config.paths.data,
          store: this.store,
          scheduler: this.scheduler,
          clearSession: () => this.clearSession(),
          uptimeSeconds: () => process.uptime(),
        })
        if (cmdResult !== null) {
          return {
            response: cmdResult,
            tool_calls_made: 0,
            tokens_used: { input: 0, output: 0 },
            duration_ms: Date.now() - start,
          }
        }
      }

      const { system } = await this.assembler.assemble(trigger, currentInput)
      // 工具列表实时取,热加载/MCP 后续注册的也能被模型看到
      const toolDefs = this.tools.toAnthropicTools()

      // 本次 cycle 的消息往哪发:消息触发就回到来源网关,自主唤醒走 autonomous
      const replySource = trigger.type === 'message' ? trigger.message.source : 'autonomous'

      if (trigger.type === 'message') {
        const baseText = trigger.message.content.type === 'text'
          ? trigger.message.content.text
          : `[${trigger.message.content.type}]`
        // 群聊带上下文时,把其他人的发言拼在前面
        const text = trigger.message.context
          ? `${trigger.message.context}\n[有人@你] ${baseText}`
          : baseText

        this.sessionHistory.push({ role: 'user', content: text })
        this.assembler.setLastUserContact(new Date())

        this.store?.insertEpisode({
          id: `ep_${Date.now().toString(36)}_u`,
          timestamp: new Date().toISOString(),
          source: 'chat',
          role: 'user',
          content: text,
          summary: null,
          embedding: null,
          session_id: this.sessionId,
          topic_tags: null,
          entities: jsonOrNull(extractEntities(text)),
        })
      } else if (this.sessionHistory.length === 0) {
        // 自主醒来且没有任何对话历史:空 messages 数组会被 GLM/Claude 拒收(2013 messages must not be empty)
        this.sessionHistory.push({
          role: 'user',
          content: '(你自己醒了,这会儿没有新消息。唤醒原因看上面,想做什么自己决定)',
        })
      }

      // 简单寒暄不值得 30-60s 的深度推理:短、无疑问、无任务动词的消息禁 thinking 秒回。
      // 拿不准的(带问号/任务词/长文本)一律保持推理,宁慢勿浅
      const isSimpleChat = trigger.type === 'message'
        && trigger.message.content.type === 'text'
        && trigger.message.content.text.length <= 20
        && !/[查帮搜找分析想念记得为什么怎么吗呢??]/.test(trigger.message.content.text)

      let messages = this.buildMessages()
      let turns = 0
      let finalText = ''

      while (turns < this.config.agent.max_turns_per_cycle) {
        turns++

        const response = await this.router.chat({
          system,
          messages,
          tools: toolDefs.length > 0 ? toolDefs : undefined,
          max_tokens: this.config.model.primary.max_tokens ?? 4096,
          thinking: isSimpleChat ? 'disabled' : undefined,
        })

        totalInput += response.usage.input_tokens
        totalOutput += response.usage.output_tokens
        totalCacheRead += response.usage.cache_read_input_tokens ?? 0

        const textBlocks = response.content.filter(b => b.type === 'text')
        const toolUseBlocks = response.content.filter(b => b.type === 'tool_use')

        if (textBlocks.length > 0) {
          finalText = textBlocks.map(b => b.text).join('')
        }

        if (toolUseBlocks.length === 0) {
          // 存进会话历史前先抹掉 WAKE/MOOD 指令，否则模型下一轮看到自己上次的指令格式会复读
          this.sessionHistory.push({ role: 'assistant', content: this.cleanResponse(finalText) })
          break
        }

        this.sessionHistory.push({ role: 'assistant', content: response.content })

        const toolResults: ContentBlock[] = []
        for (const block of toolUseBlocks) {
          toolCallCount++
          const toolStart = Date.now()
          const result = await this.tools.execute(
            block.name!,
            block.input!,
            {
              config: this.config,
              dataDir: this.config.paths.data,
              log: (msg: string) => console.log(`  [tool:${block.name}] ${msg}`),
              sendMessage: this.sendRouter
                ? (text: string, imagePath?: string) => this.sendRouter!(replySource, text, imagePath)
                : undefined,
              scheduleWake: this.scheduler
                ? (seconds, reason, activity) => {
                    this.scheduler!.scheduleNext({ seconds, reason, activity_type: activity })
                    this.assembler.setLastWake(new Date(), activity)
                  }
                : undefined,
            },
          )

          log.trace('tool', block.name ?? '?', {
            ok: result.success,
            ms: Date.now() - toolStart,
            error: result.success ? undefined : result.error,
          })

          // stream_note 等工具用 _stream_entry 给意识流留备忘 —— 这里是唯一的消费点,
          // 不接的话她调了 stream_note 也一条都落不了盘(06-09 连调 6 次全丢的事故)
          const se = (result as typeof result & {
            _stream_entry?: { content: string; activity_type?: string }
          })._stream_entry
          if (se?.content) {
            this.assembler.streamLayer.append(se.content, se.activity_type)
          }

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result.success ? result.output : `错误: ${result.error}`,
          })
        }

        this.sessionHistory.push({ role: 'user', content: toolResults })
        messages = this.buildMessages()
      }

      if (turns >= this.config.agent.max_turns_per_cycle && !finalText) {
        console.warn(`[agent-loop] 达到 max_turns(${turns}) 仍未产出最终回复`)
      }

      this.postProcess(finalText, trigger).catch(err =>
        console.error(`[post-process] ${(err as Error).message}`)
      )

      this.store?.logTokenUsage({
        input: totalInput,
        output: totalOutput,
        cache_read: totalCacheRead,
        model: this.router.primaryName,
        trigger: trigger.type,
        duration: Date.now() - start,
      })

      this.lastActivity = Date.now()
      this.lastSuccessAt = new Date()
      this.consecutiveFailures = 0

      return {
        response: this.cleanResponse(finalText),
        tool_calls_made: toolCallCount,
        tokens_used: { input: totalInput, output: totalOutput, cache_read: totalCacheRead },
        duration_ms: Date.now() - start,
      }
    } catch (err) {
      // 连续失败大概率是 sessionHistory 本身坏了(孤儿 tool_result 等),
      // 同一份坏 payload 重试一万次也不会好——清掉自愈,给意识流留一笔
      this.consecutiveFailures++
      if (this.consecutiveFailures >= 3) {
        console.error(`[agent-loop] 连续 ${this.consecutiveFailures} 次 cycle 失败,清空会话历史自愈`)
        this.assembler.streamLayer.append('刚才有段对话出了问题,连着几次说不出话,把那段聊天清掉重新开始了', 'system')
        this.clearSession()
        this.consecutiveFailures = 0
      }
      throw err
    } finally {
      this.running = false
    }
  }

  private buildMessages(): ChatMessage[] {
    this.sessionHistory = trimHistory(this.sessionHistory, 40)
    return [...this.sessionHistory]
  }

  private async postProcess(response: string, trigger: WakeTrigger): Promise<void> {
    // 顺序要紧：先在原文上抽指令（下面 extractMood/extractWakeDirective 依赖原文），
    // 再用清洗后的文本写记忆/抽实体——否则 [WAKE]/[MOOD] 会污染长期记忆和实体表
    const streamEntry = this.extractStreamEntry(response)
    if (streamEntry) {
      this.assembler.streamLayer.append(streamEntry.content, streamEntry.activity)
    }

    // style-guard 只挡发给用户的消息,自主 cycle 的内心独白没人挡,
    // markdown 粗体曾直接进了长期记忆(9 条)——入库前统一清一遍
    const rawCleaned = this.cleanResponse(response)
    const cleaned = rawCleaned ? guardStyle(rawCleaned).cleaned : ''
    if (cleaned) {
      this.store?.insertEpisode({
        id: `ep_${Date.now().toString(36)}_a`,
        timestamp: new Date().toISOString(),
        source: 'chat',
        role: 'assistant',
        content: cleaned.slice(0, 500),
        summary: null,
        embedding: null,
        session_id: this.sessionId,
        topic_tags: null,
        entities: jsonOrNull(extractEntities(cleaned)),
      })
    }

    // agent 在回复里写了 [MOOD:情绪:原因] 就更新心情
    const mood = this.extractMood(response)
    if (mood) {
      updateMood(this.config.paths.data, mood.mood, mood.reason)
    }

    const wakeDirective = this.extractWakeDirective(response)
    if (wakeDirective && this.scheduler) {
      this.scheduler.scheduleNext(wakeDirective)
      this.assembler.setLastWake(new Date(), wakeDirective.activity_type)
    }

    // 给还没算 embedding 的记忆补算(有 embedding 服务才做)
    await this.backfillEmbeddings()

    if (this.consolidation?.shouldConsolidate()) {
      await this.consolidation.consolidate()
    }

    await this.maybeCompactSession()
  }

  // session autocompact:历史超过 30 条就把头部压成一条"前情提要",原位替换。
  // 这样长会话丢的是细节不是事实,trimHistory 的硬裁剪降级为压缩失败时的兜底。
  // 跑在 postProcess(异步)里,期间下一个 cycle 可能已开动,所以替换前做代次校验。
  private async maybeCompactSession(): Promise<void> {
    if (this.compacting || !this.consolidation) return
    if (this.sessionHistory.length <= 30) return
    this.compacting = true
    try {
      const sessionId = this.sessionId
      // 头部至少 16 条,延伸到安全切点,保证替换后剩余历史以纯文本 user 开头
      let headEnd = 16
      while (headEnd < this.sessionHistory.length - 8 && !isSafeStart(this.sessionHistory[headEnd]!)) {
        headEnd++
      }
      if (headEnd >= this.sessionHistory.length - 4) return
      const head = this.sessionHistory.slice(0, headEnd)

      const summary = await this.consolidation.compactHistory(head)
      if (!summary) return

      // 代次校验:压缩期间 session 被轮转/清空/裁剪过就放弃(宁可不压,不能错接)
      if (this.sessionId !== sessionId) return
      if (this.sessionHistory.length < headEnd || this.sessionHistory[0] !== head[0]) return

      this.sessionHistory.splice(0, headEnd, {
        role: 'user',
        content: `[前情提要,你们之前聊的浓缩] ${summary}`,
      })
      console.log(`[agent-loop] 会话压缩: ${headEnd} 条 → 1 条前情提要`)
    } finally {
      this.compacting = false
    }
  }

  private async backfillEmbeddings(): Promise<void> {
    if (!this.embedding?.available || !this.store) return
    const pending = this.store.getEpisodesNeedingEmbedding(10)
    for (const ep of pending) {
      const vec = await this.embedding.embed(ep.content)
      if (vec) this.store.updateEmbedding(ep.id, EmbeddingService.toBuffer(vec))
    }
  }

  private extractMood(text: string): { mood: string; reason: string } | null {
    const m = text.match(/\[MOOD:([^:\]\n]+):?([^\]\n]*)\]?/)
    if (!m) return null
    return { mood: m[1]!.trim(), reason: (m[2] ?? '').trim() }
  }

  // 距上次活动超过超时时间,把当前会话历史归档(后台生成摘要),清空开新会话
  private maybeRotateSession(): void {
    const timeoutMs = this.config.agent.session_timeout_minutes * 60 * 1000
    if (this.sessionHistory.length === 0) return
    if (Date.now() - this.lastActivity < timeoutMs) return

    const oldSession = this.sessionId
    const history = this.sessionHistory
    this.sessionHistory = []
    this.sessionId = `s_${Date.now().toString(36)}`

    // 会话摘要交给整合机制,这里只记一条归档标记
    if (this.consolidation) {
      this.consolidation.summarizeSession(oldSession, history).catch(() => { /* 摘要失败不阻塞 */ })
    }
  }

  private extractStreamEntry(text: string): { content: string; activity?: string } | null {
    if (!text) return null
    // 长度判断必须在清洗之后:纯 [WAKE][MOOD] 指令的回复清洗完是空的,
    // 旧逻辑在清洗前判长度,导致意识流里出现空白条目
    const clean = text
      .replace(/\[WAKE:[^\]\n]*\]?/g, '')
      .replace(/\[MOOD:[^\]\n]*\]?/g, '')
      .replace(/\n+/g, ' ')
      .trim()
    if (clean.length < 5) return null
    return { content: truncateAtBoundary(clean, 200), activity: 'chat' }
  }

  private extractWakeDirective(text: string): { seconds: number; reason: string; activity_type: string } | null {
    const match = text.match(/\[WAKE:(\d+):([^:]*):([^\]\n]*)\]?/)
    if (!match) return null
    return {
      seconds: parseInt(match[1]!),
      reason: match[2]!.trim(),
      activity_type: match[3]!.trim(),
    }
  }

  private cleanResponse(text: string): string {
    // 把内部指令标记从给用户看的文本里抹掉
    return text
      .replace(/\[WAKE:[^\]\n]*\]?/g, '')
      .replace(/\[MOOD:[^\]\n]*\]?/g, '')
      .trim()
  }

  clearSession(): void {
    this.sessionHistory = []
    this.sessionId = `s_${Date.now().toString(36)}`
  }

  // mu.ts 注入:把 message_send 的文本(可带图片)路由到对应网关
  setSendRouter(fn: (source: string, text: string, imagePath?: string) => Promise<void>): void {
    this.sendRouter = fn
  }

  get isRunning(): boolean {
    return this.running
  }

  // cron 兜底和 /api/status 用:她最后一次成功跑通 cycle 是什么时候
  get health(): { lastSuccessAt: Date | null; consecutiveFailures: number } {
    return { lastSuccessAt: this.lastSuccessAt, consecutiveFailures: this.consecutiveFailures }
  }
}

// 裁剪会话历史,切点必须落在"纯文本 user 消息"上。
// 硬 slice(-n) 会把 assistant 的 tool_use 和后面的 tool_result 切开,留下孤儿
// tool_result —— GLM 对此 400(2013 tool id not found),且坏历史驻留后每次请求都失败(06-09 事故根因)。
export function trimHistory(history: ChatMessage[], max: number): ChatMessage[] {
  if (history.length <= max) return history
  let start = history.length - max
  while (start < history.length && !isSafeStart(history[start]!)) start++
  if (start >= history.length) {
    // 窗口内没有安全切点(超长工具链):向前扩窗到最近的安全点,宁可多带几条也不发坏历史
    start = history.length - max
    while (start > 0 && !isSafeStart(history[start]!)) start--
  }
  return history.slice(start)
}

function isSafeStart(m: ChatMessage): boolean {
  if (m.role !== 'user') return false
  if (typeof m.content === 'string') return true
  return !m.content.some(b => b.type === 'tool_result')
}

// 意识流截断:超长时尽量在标点/空格处断,别把一句话腰斩("也可能已"这种)
function truncateAtBoundary(text: string, max: number): string {
  if (text.length <= max) return text
  const slice = text.slice(0, max)
  const boundary = Math.max(
    slice.lastIndexOf(' '),
    ...['。', '!', '?', '!', '?', ',', ',', ' ', '…'].map(p => slice.lastIndexOf(p)),
  )
  return boundary > max * 0.6 ? slice.slice(0, boundary + 1).trim() : slice
}

function jsonOrNull(arr: string[]): string | null {
  return arr.length > 0 ? JSON.stringify(arr) : null
}
