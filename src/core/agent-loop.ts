import { join } from 'node:path'
import type { MuConfig, WakeTrigger, ContentBlock, CycleResult } from './types.js'
import { ContextAssembler } from './context-assembler.js'
import { ModelRouter } from '../providers/router.js'
import { ToolRegistry } from '../tools/registry.js'
import type { MemoryStore } from '../memory/store.js'
import type { Scheduler } from './scheduler.js'
import type { MemoryConsolidation } from '../memory/consolidation.js'
import { EmbeddingService } from '../memory/embedding.js'
import { extractEntities } from '../memory/entities.js'
import { guardStyle } from '../soul/style-guard.js'
import { log } from './logger.js'
import { tryCommand } from './commands.js'
import { cleanResponse } from './loop/directives.js'
import { SessionStore } from './loop/session-store.js'

export class AgentLoop {
  private config: MuConfig
  private assembler: ContextAssembler
  private router: ModelRouter
  private tools: ToolRegistry
  private store: MemoryStore | null
  private scheduler: Scheduler | null
  private consolidation: MemoryConsolidation | null
  private embedding: EmbeddingService | null
  private session: SessionStore
  private running = false
  private lastSuccessAt: Date | null = null
  private consecutiveFailures = 0
  private sendRouter: ((source: string, text: string, imagePath?: string) => Promise<void>) | null = null
  private opsAlert: ((text: string) => Promise<void>) | null = null
  private lastOpsAlertAt = 0

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
    this.session = new SessionStore(join(this.config.paths.data, 'memory', 'session.json'))
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

    // 距上次活动超过 session 超时,先归档旧会话(摘要交整合机制)再开新的。
    // lastActivity 只在 cycle 成功后更新(见 try 末尾)——失败的 cycle 不算活动,
    // 否则坏历史导致的反复失败会一直刷新计时,session 永不轮转,坏历史永生(06-09 事故)。
    this.session.maybeRotate(this.config.agent.session_timeout_minutes * 60 * 1000, (oldId, hist) => {
      this.consolidation?.summarizeSession(oldId, hist).catch(() => { /* 摘要失败不阻塞 */ })
    })

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

        // 会话历史里的 user 消息带时刻前缀:没有它,10 分钟前和 2 小时前的消息
        // 在 history 里长得一样,她对"间隔"是盲的(哥哥要求时间意识高度清晰)。
        // episodes 入库用原文——时间戳列里有,别让格式渗进长期记忆
        this.session.push({ role: 'user', content: `[${stamp()}] ${text}` })
        this.assembler.setLastUserContact(new Date())

        this.store?.insertEpisode({
          id: `ep_${Date.now().toString(36)}_u`,
          timestamp: new Date().toISOString(),
          source: 'chat',
          role: 'user',
          content: text,
          summary: null,
          embedding: null,
          session_id: this.session.sessionId,
          topic_tags: null,
          entities: jsonOrNull(extractEntities(text)),
        })
      } else if (this.session.length === 0) {
        // 自主醒来且没有任何对话历史:空 messages 数组会被 GLM/Claude 拒收(2013 messages must not be empty)
        this.session.push({
          role: 'user',
          content: `[${stamp()}] (你自己醒了,这会儿没有新消息。唤醒原因看上面,想做什么自己决定)`,
        })
      }

      // 简单寒暄不值得 30-60s 的深度推理:短、无疑问、无任务动词的消息禁 thinking 秒回。
      // 拿不准的(带问号/任务词/长文本)一律保持推理,宁慢勿浅
      const isSimpleChat = trigger.type === 'message'
        && trigger.message.content.type === 'text'
        && trigger.message.content.text.length <= 20
        && !/[查帮搜找分析想念记得为什么怎么吗呢??]/.test(trigger.message.content.text)

      let messages = this.session.buildMessages()
      let turns = 0
      let finalText = ''
      let lastSubstantive = ''   // 最近一轮去掉 WAKE/MOOD 指令后仍有内容的文本

      // cycle 时间预算:20 轮 × GLM 慢推理能跑半小时,期间哥哥的消息全在排队(失联感)。
      // 哥哥在等的 cycle 5 分钟收尾;自主活动没人等,给 15 分钟做深度的事
      const budgetMs = (trigger.type === 'message' ? 300 : 900) * 1000

      while (turns < this.config.agent.max_turns_per_cycle) {
        if (turns > 0 && Date.now() - start > budgetMs) {
          console.warn(`[agent-loop] cycle 超时间预算(${Math.round((Date.now() - start) / 1000)}s),带现有结果收尾`)
          break
        }
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
          if (cleanResponse(finalText)) lastSubstantive = finalText
        }

        if (toolUseBlocks.length === 0) {
          // 存进会话历史前先抹掉 WAKE/MOOD 指令，否则模型下一轮看到自己上次的指令格式会复读。
          // 清洗后为空(纯指令轮)就不 push——正文已随带 tool 的轮存进历史,空 assistant 消息没价值
          const cleanedTurn = cleanResponse(finalText)
          if (cleanedTurn) this.session.push({ role: 'assistant', content: cleanedTurn })
          break
        }

        this.session.push({ role: 'assistant', content: response.content })

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
              store: this.store ?? undefined,
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

        this.session.push({ role: 'user', content: toolResults })
        messages = this.session.buildMessages()
      }

      if (turns >= this.config.agent.max_turns_per_cycle && !finalText) {
        console.warn(`[agent-loop] 达到 max_turns(${turns}) 仍未产出最终回复`)
      }

      // GLM 多轮工具后,最后一轮常只剩 [WAKE:...] 指令——finalText 被覆盖成纯指令,
      // 清洗后为空,中间轮生成的正文整段蒸发,用户视角"已读不回"(06-10 10:54 实锤:
      // 687 token 查了一堆去处,回复却是空)。回退:正文取最近的实质文本,指令保留给 postProcess
      if (!cleanResponse(finalText) && lastSubstantive) {
        const directives = finalText.match(/\[(?:WAKE|MOOD):[^\]\n]*\]?/g)?.join(' ') ?? ''
        console.warn('[agent-loop] 末轮只有指令无正文,回退到上一轮实质内容')
        finalText = directives ? `${lastSubstantive}\n${directives}` : lastSubstantive
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

      this.session.markActivity()
      this.lastSuccessAt = new Date()
      this.consecutiveFailures = 0
      this.session.persist()

      return {
        response: cleanResponse(finalText),
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
        // 06-09 晚的死亡螺旋跑了 70 多分钟没人知道——出这种事必须有人收到信
        this.sendOpsAlert(`[Shion 系统] 连续 3 次没跑通,已自动清空会话自愈。最后的错: ${(err as Error).message.slice(0, 150)}`)
      }
      throw err
    } finally {
      this.running = false
    }
  }

  private async postProcess(response: string, _trigger: WakeTrigger): Promise<void> {
    // 入库前清洗:自主 cycle 的内心独白没经过发送侧的处理,统一清一遍再存
    const rawCleaned = cleanResponse(response)
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
        session_id: this.session.sessionId,
        topic_tags: null,
        entities: jsonOrNull(extractEntities(cleaned)),
      })
    }

    // 专业助理被动响应:不解析 [MOOD]/[WAKE],也不自动给自己安排下次唤醒。
    // 用户主动要的定时提醒走 schedule_wake 工具(在上面工具执行循环里调 scheduler.scheduleNext)。
    // cron 仍在兜底:错过的 pending 提醒(scheduler 情况1)会被补唤醒。

    // 给还没算 embedding 的记忆补算(有 embedding 服务才做)
    await this.backfillEmbeddings()

    if (this.consolidation?.shouldConsolidate()) {
      await this.consolidation.consolidate()
    }

    await this.session.maybeCompact(this.consolidation)
  }

  private async backfillEmbeddings(): Promise<void> {
    if (!this.embedding?.available || !this.store) return
    const pending = this.store.getEpisodesNeedingEmbedding(10)
    for (const ep of pending) {
      const vec = await this.embedding.embed(ep.content)
      if (vec) this.store.updateEmbedding(ep.id, EmbeddingService.toBuffer(vec))
    }
  }

  // 启动时恢复落盘会话(mu.ts 调,在第一个 cycle 之前)
  restoreSession(): void {
    this.session.restore()
  }

  // 运维告警(mu.ts 注入,直接 POST QQ bridge,不过 LLM、不占 proactive 配额)。
  // 1 小时节流:死亡螺旋下每 30 分钟自愈一次,告警别跟着刷屏
  private sendOpsAlert(text: string): void {
    if (!this.opsAlert) return
    if (Date.now() - this.lastOpsAlertAt < 3600_000) return
    this.lastOpsAlertAt = Date.now()
    this.opsAlert(text).catch(err =>
      console.error(`[ops-alert] 告警也没发出去: ${(err as Error).message}`))
  }

  setOpsAlert(fn: (text: string) => Promise<void>): void {
    this.opsAlert = fn
  }

  clearSession(): void {
    this.session.clear()
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

function jsonOrNull(arr: string[]): string | null {
  return arr.length > 0 ? JSON.stringify(arr) : null
}

// 会话内消息的时刻前缀,如 "6-10 13:02"。给她消息级的时间分辨率(间隔感)
function stamp(): string {
  const d = new Date()
  return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
