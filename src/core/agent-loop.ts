import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import type { MuConfig, WakeTrigger, CycleResult } from './types.js'
import { ContextAssembler } from './context-assembler.js'
import { ModelRouter } from '../providers/router.js'
import { ToolRegistry } from '../tools/registry.js'
import type { MemoryStore } from '../memory/store.js'
import type { Scheduler } from './scheduler.js'
import type { MemoryConsolidation } from '../memory/consolidation.js'
import { EmbeddingService } from '../memory/embedding.js'
import { extractEntities } from '../memory/entities.js'
import { guardStyle } from '../soul/style-guard.js'
import { tryCommand } from './commands.js'
import { cleanResponse } from './loop/directives.js'
import { runToolLoop } from './loop/tool-loop.js'
import { SessionStore } from './loop/session-store.js'
import { resetSubagentTaskBudget } from '../tools/builtin/spawn-subagent.js'
import {
  loadTasks, pickNextWakeFromTasks, bumpWakeCount,
  taskProgressSig, recordTaskProgress, blockCappedTasks, addNotifiedBlocked,
  pendingBlockedNotices,
} from '../memory/active-tasks.js'

// task 续唤醒的 reason 前缀。getStatus().reason 据此区分"task 自唤醒"和"用户 schedule_wake 提醒"
// (scheduler.ts 不暴露 activity_type,只能靠 reason)。task 唤醒可覆盖,用户提醒绝不覆盖。
const TASK_WAKE_REASON_PREFIX = '推进任务 '

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
    // 每个 cycle 重置子代理总数预算(MAX_SUBAGENTS_PER_TASK 按 cycle 计)。cycle 互斥(running),无并发抢
    resetSubagentTaskBudget()
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
      const allToolDefs = this.tools.toAnthropicTools()
      // 金融 cycle 的语义已明确,没必要把地图/火车/微博/Playwright 等全部 schema
      // 塞给 provider。这不仅浪费几万 input token,也会扩大严格 API 拒绝整个 tools 参数的概率。
      const financialCycle = isFinancialTrigger(trigger, loadKnownFinancialEntities(this.config.paths.data))
      const toolDefs = financialCycle ? selectFinancialTools(allToolDefs) : allToolDefs

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

      // cycle 时间预算:20 轮 × GLM 慢推理能跑半小时,期间哥哥的消息全在排队(失联感)。
      // 哥哥在等的 cycle 5 分钟收尾;自主活动没人等,给 15 分钟做深度的事。
      // 但自主推进 task 的 cycle(activity_type==='task')压到 5 分钟——别让单步占满拖慢续唤醒节奏。
      const isTaskCycle = trigger.type === 'self_scheduled' && trigger.activity_type === 'task'
      const budgetMs = (trigger.type === 'message' || isTaskCycle ? 300 : 900) * 1000

      // 无进展检测的起点快照:task cycle 跑之前先记下该 task 的进展指纹,
      // postProcess 里(scheduleTaskContinuation 之前)reload 比对,不变则 fail_streak++。
      let taskProgressBaseline: { taskId: string; sig: string } | null = null
      if (isTaskCycle && trigger.type === 'self_scheduled') {
        const before = loadTasks(this.config.paths.data).tasks
          .find(t => trigger.reason.includes(t.id))
        if (before) taskProgressBaseline = { taskId: before.id, sig: taskProgressSig(before) }
      }

      // H2 去重基线:cycle 开头(= assemble 注入"告知用户"提示的同一时刻)就 blocked 且未告知的
      // task id —— 正是本轮 assemble 注入了提示的那批。postProcess 只对这批落 notified_blocked,
      // 不误标本轮 postProcess 才自动 block(assemble 已跑完、下轮才注入)的 task,否则永不告知。
      const blockedNoticeBaseline = pendingBlockedNotices(loadTasks(this.config.paths.data)).map(t => t.id)

      // 多轮工具循环抽到 loop/tool-loop.ts(主/子代理共用)。副作用全走回调:assistant/tool_result
      // 入 session、_stream_entry 进意识流、每轮重取消息走 session.buildMessages()(trimHistory 仍在
      // session-store)。末轮纯指令回退、budget 守卫、无 tool_use 判停都在 runToolLoop 内。
      const loopResult = await runToolLoop({
        system,
        messages: this.session.buildMessages(),
        tools: toolDefs,
        router: this.router,
        maxTurns: this.config.agent.max_turns_per_cycle,
        budgetMs,
        maxTokens: this.config.model.primary.max_tokens ?? 4096,
        thinking: isSimpleChat ? 'disabled' : undefined,
        // 真金白银场景不能在主模型故障时静默降级到已知会编造数字的 fallback。
        // watchdog 仍是确定性链路,不依赖模型;普通生活对话保留 fallback 自愈。
        fallbackPolicy: financialCycle ? 'deny' : undefined,
        executeTool: (name, input) => this.tools.execute(name, input, {
          config: this.config,
          dataDir: this.config.paths.data,
          store: this.store ?? undefined,
          depth: 0, // 主 cycle 是 depth 0;子代理 subCtx 传 +1。spawn_subagent 据此 depth 硬闸
          log: (msg: string) => console.log(`  [tool:${name}] ${msg}`),
          sendMessage: this.sendRouter
            ? (text: string, imagePath?: string) => this.sendRouter!(replySource, text, imagePath)
            : undefined,
          scheduleWake: this.scheduler
            ? (seconds, reason, activity) => {
                this.scheduler!.scheduleNext({ seconds, reason, activity_type: activity })
                this.assembler.setLastWake(new Date(), activity)
              }
            : undefined,
        }),
        canExecuteInParallel: names => this.tools.areParallelSafe(names),
        onAssistant: (msg) => this.session.push(msg),
        onToolResult: (msg) => this.session.push(msg),
        onStreamEntry: (entry, activityType) => this.assembler.streamLayer.append(entry, activityType),
        rebuildMessages: () => this.session.buildMessages(),
      })

      const finalText = loopResult.finalText
      totalInput += loopResult.usage.input
      totalOutput += loopResult.usage.output
      totalCacheRead += loopResult.usage.cacheRead
      toolCallCount += loopResult.toolCallCount

      if (loopResult.turns >= this.config.agent.max_turns_per_cycle && !finalText) {
        console.warn(`[agent-loop] 达到 max_turns(${loopResult.turns}) 仍未产出最终回复`)
      }

      this.postProcess(finalText, trigger, taskProgressBaseline, blockedNoticeBaseline).catch(err =>
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

  private async postProcess(
    response: string, _trigger: WakeTrigger,
    taskProgressBaseline?: { taskId: string; sig: string } | null,
    blockedNoticeBaseline: string[] = [],
  ): Promise<void> {
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

    // 自主推进的状态收尾(只在成功路径跑,失败 cycle 走 catch 到不了这)。顺序有意为之:
    //   1) 无进展检测:本轮 task 没动 → fail_streak++(驱动 backoff 翻倍);达 3 次自动 blocked。
    //   2) wake_count 撞顶的 task 转 blocked(否则只是不再被 pick、status 没转)。
    //   3) 已 blocked 且这轮已被注入"告知用户"提示的 task → 标记 notified,防下次重复注入(去重)。
    //   4) 续唤醒(pickNextWakeFromTasks 已排除 blocked/到顶的,退避按更新后的 fail_streak)。
    this.recordTaskProgressIfTask(taskProgressBaseline)
    this.blockCappedAndDedupNotices(blockedNoticeBaseline)

    this.scheduleTaskContinuation()

    // 给还没算 embedding 的记忆补算(有 embedding 服务才做)
    await this.backfillEmbeddings()

    if (this.consolidation?.shouldConsolidate()) {
      await this.consolidation.consolidate()
    }

    await this.session.maybeCompact(this.consolidation)
  }

  // H1:task cycle 无进展检测。fail_streak++/归0/达3自动 blocked 的逻辑在 active-tasks。
  // 只在成功路径调;只对本轮确实跑了 task 的 cycle(有 baseline)生效。
  private recordTaskProgressIfTask(baseline?: { taskId: string; sig: string } | null): void {
    if (!baseline) return
    recordTaskProgress(
      this.config.paths.data, baseline.taskId, baseline.sig,
      (msg) => console.log(`  [task-progress] ${msg}`),
    )
  }

  // H2:wake_count 撞顶的 task 转 blocked + 对已 blocked 但本轮已注入告知提示的 task 标记 notified。
  // context-assembler 注入"请告知用户一次"提示,这里在成功 cycle 后落 notified_blocked 去重,
  // 保证同一 blocked task 的提示只注入一次(防刷屏的状态层硬保证,不靠模型纪律)。
  private blockCappedAndDedupNotices(injectedNoticeIds: string[]): void {
    const dataDir = this.config.paths.data
    // wake_count 撞顶的 task 转 blocked(否则只是不再被 pick、status 没转)。
    blockCappedTasks(dataDir, (msg) => console.log(`  [task-block] ${msg}`))
    // 只对【本轮 assemble 实际注入过"告知用户"提示】的 task(cycle 开头就 blocked&未告知,见
    // blockedNoticeBaseline)落 notified_blocked 去重。本轮 postProcess 才刚自动 block 的 task 不在
    // 基线里 → 不标 → 下轮 assemble 注入提示后再标,否则永远不会告知用户。
    for (const id of injectedNoticeIds) {
      addNotifiedBlocked(dataDir, id, (msg) => console.log(`  [task-notify] ${msg}`))
    }
  }

  // 自主推进的续唤醒(只在 cycle 成功后、postProcess 里调)。纯函数 pickNextWakeFromTasks
  // 决定有没有可推进的 task:返回 null = 无 open task = 不排任何唤醒(退回纯被动)。
  // 红线:bumpWakeCount 在排唤醒时 +1(挂掉的 cycle 计数照涨,MAX_WAKES_PER_TASK 物理封顶);
  // 写盘失败 fail-closed(不排,cron 兜底接);绝不碰 trimHistory / 3 连败 / markActivity。
  private scheduleTaskContinuation(): void {
    if (!this.scheduler) return
    const dataDir = this.config.paths.data
    const pick = pickNextWakeFromTasks(loadTasks(dataDir).tasks, Date.now())
    if (!pick) return // 无可推进 task,退回纯被动

    const seconds = Math.max(0, Math.round((Date.parse(pick.wakeAt) - Date.now()) / 1000))

    // 多 wake 调度:用户提醒与不同 task 各自占一个槽,互不覆盖。只对“同一个 task”去重:
    // 已有 wake 更早则保持；已有 wake 更晚则前移，但不重复 bump wake_count。
    const reason = `${TASK_WAKE_REASON_PREFIX}${pick.taskId}`
    const existing = this.scheduler.getScheduledWakes()
      .find(w => w.kind === 'task' && w.reason === reason)
    const desiredAt = Date.now() + seconds * 1000
    if (existing && Date.parse(existing.at) <= desiredAt) return

    // 首次为该 task 排 wake 才计数；重排同一 wake 不重复计数。
    if (!existing
      && !bumpWakeCount(dataDir, pick.taskId, (msg) => console.log(`  [task-wake] ${msg}`))) {
      console.warn('[agent-loop] bumpWakeCount 写盘失败,本次不排续唤醒(cron 兜底接)')
      return
    }
    this.scheduler.scheduleNext({
      seconds,
      reason,
      activity_type: 'task',
    })
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

const A_SHARE_CODE = /(?<!\d)[034689]\d{5}(?!\d)/
const EXPLICIT_FINANCE_INTENT = /A\s*股|股票|股价|行情|持仓|仓位|买入|加仓|补仓|减仓|清仓|止损|止盈|估值|财报|研报|回测|选股|模拟盘|ETF|指数|板块|盈亏|证券|交易策略|投资(?:组合|策略|收益|标的|逻辑|建议|风险)|基金(?:净值|持仓|定投|申购|赎回|配置|经理|产品)/i
const LISTED_COMPANY_SUBJECT = /(?:\*?ST)?[A-Za-z\u4e00-\u9fff]{1,12}(?:公司|银行|证券|保险|股份|集团|控股|科技|能源|电力|医药|制药|汽车|电子|光电|通信|材料|矿业|航空|重工|食品|茅台)/i
const BUY_SELL_HOLD_QUESTION = /怎么看|如何看|(?:现在|目前|还)?(?:能买吗|能不能买|可以买|值得买)|(?:要不要|该不该|是否适合).{0,6}(?:买|卖|拿|持有|补仓|加仓|减仓|清仓)|(?:继续)(?:拿着|持有)/

// 金融 cycle 是 fail-closed 安全边界。明确金融术语/6 位 A 股代码直接命中；
// “公司名 + 买卖持有疑问”单独覆盖口语问法。刻意不使用裸 投资/基金/卖出，避免生活语义误报。
export function isFinancialIntentText(text: string, knownEntities: ReadonlySet<string> = new Set()): boolean {
  const normalized = text.trim()
  if (!normalized) return false
  return A_SHARE_CODE.test(normalized)
    || EXPLICIT_FINANCE_INTENT.test(normalized)
    || (LISTED_COMPANY_SUBJECT.test(normalized) && BUY_SELL_HOLD_QUESTION.test(normalized))
    || (BUY_SELL_HOLD_QUESTION.test(normalized)
      && [...knownEntities].some(entity => entity.length > 0 && normalized.includes(entity)))
}

function isFinancialTrigger(trigger: WakeTrigger, knownEntities: ReadonlySet<string>): boolean {
  let text = ''
  if (trigger.type === 'message' && trigger.message.content.type === 'text') text = trigger.message.content.text
  else if (trigger.type === 'self_scheduled' || trigger.type === 'cron_fallback' || trigger.type === 'manual') text = trigger.reason
  else if (trigger.type === 'system_event') text = trigger.event
  else if (trigger.type === 'webhook') text = `${trigger.source} ${JSON.stringify(trigger.payload).slice(0, 1000)}`
  return isFinancialIntentText(text, knownEntities)
}

function loadKnownFinancialEntities(dataDir: string): Set<string> {
  const entities = new Set<string>()
  const load = (file: string, field?: string): unknown[] => {
    try {
      const path = join(dataDir, 'memory', file)
      if (!existsSync(path)) return []
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
      if (Array.isArray(parsed)) return parsed
      if (!parsed || typeof parsed !== 'object' || !field) return []
      const nested = (parsed as Record<string, unknown>)[field]
      return Array.isArray(nested) ? nested : []
    } catch { return [] }
  }
  for (const item of [...load('portfolio.json', 'positions'), ...load('investment-cases.json', 'cases')]) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (record.status !== 'active') continue
    for (const key of ['name', 'code']) {
      const value = record[key]
      if (typeof value === 'string' && value.trim()) entities.add(value.trim())
    }
  }
  return entities
}

const FINANCE_CORE_TOOLS = new Set([
  'file_read', 'file_write', 'file_list', 'web_search', 'web_fetch',
  'memory_save', 'memory_search', 'memory_update', 'memory_forget', 'knowledge_write',
  'commitment_create', 'commitment_done', 'stream_note', 'diary_write',
  'message_send', 'schedule_wake',
  'task_create', 'task_list', 'task_update', 'task_review', 'task_delete',
  'spawn_subagent', 'spawn_parallel', 'shell_exec',
])

function selectFinancialTools<T extends { name: string }>(tools: T[]): T[] {
  return tools.filter(tool => FINANCE_CORE_TOOLS.has(tool.name)
    || /^(?:portfolio_|investment_|mx_|a_stock_|ifind-|hexin-ifind-)/.test(tool.name))
}

function jsonOrNull(arr: string[]): string | null {
  return arr.length > 0 ? JSON.stringify(arr) : null
}

// 会话内消息的时刻前缀,如 "6-10 13:02"。给她消息级的时间分辨率(间隔感)
function stamp(): string {
  const d = new Date()
  return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
