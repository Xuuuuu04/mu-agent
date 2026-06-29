import type { MuConfig, WakeTrigger, AnthropicTool, ContentBlock } from './types.js'
import { IdentityLayer } from '../memory/layers/identity.js'
import { TemporalLayer } from '../memory/layers/temporal.js'
import { StreamLayer } from '../memory/layers/stream.js'
import { RelationsLayer } from '../memory/layers/relations.js'
import { EpisodicLayer } from '../memory/layers/episodic.js'
import { ProceduralLayer } from '../memory/layers/procedural.js'
import { WorldLayer } from '../memory/layers/world.js'
import type { MemoryStore } from '../memory/store.js'
import type { EmbeddingService } from '../memory/embedding.js'
import { BEHAVIOR_RULES } from './behavior-rules.js'
import {
  loadTasks, formatTaskFull, formatOpenTasksSummary, countOpenTasks, isOpenLike,
  pendingBlockedNotices, formatBlockedNotices,
} from '../memory/active-tasks.js'

export interface AssemblyResult {
  system: ContentBlock[]
  tools: AnthropicTool[]
}

export class ContextAssembler {
  private identity: IdentityLayer
  private temporal: TemporalLayer
  private stream: StreamLayer
  private relations: RelationsLayer
  private episodic: EpisodicLayer | null = null
  private procedural: ProceduralLayer
  private world: WorldLayer
  private registeredTools: AnthropicTool[] = []
  private dataDir: string

  private lastUserContact?: Date
  private lastWake?: { time: Date; activity: string }

  constructor(config: MuConfig, store?: MemoryStore, embedding?: EmbeddingService | null) {
    this.dataDir = config.paths.data
    this.identity = new IdentityLayer(config.paths.soul)
    this.temporal = new TemporalLayer(config.paths.data)
    this.stream = new StreamLayer(config.paths.data)
    this.relations = new RelationsLayer(config.paths.data)
    this.procedural = new ProceduralLayer(config.paths.data)
    this.world = new WorldLayer(config.paths.data)
    if (store) {
      this.episodic = new EpisodicLayer(store, embedding)
    }
  }

  registerTools(tools: AnthropicTool[]): void {
    this.registeredTools = tools
  }

  setLastUserContact(time: Date): void {
    this.lastUserContact = time
  }

  setLastWake(time: Date, activity: string): void {
    this.lastWake = { time, activity }
  }

  async assemble(trigger: WakeTrigger, currentInput?: string): Promise<AssemblyResult> {
    const systemBlocks: ContentBlock[] = []

    // 第一段:身份 + 行为规则。最稳定,标 cache。配合 tools 的 cache,构成稳定缓存前缀。
    const identityText = this.identity.assemble()
    const relationsText = this.relations.assemble()

    systemBlocks.push({
      type: 'text',
      text: identityText + '\n\n' + BEHAVIOR_RULES,
      cache_control: { type: 'ephemeral' },
    })

    // 关系事实(user-facts/commitments):会随记忆操作变。放 cache 块之后,
    // 它变了不会破坏前面 identity+rules+tools 的缓存(否则每改一次记忆 cache 全失效)。
    systemBlocks.push({
      type: 'text',
      text: relationsText,
    })

    // 第二段:时间/意识流/检索记忆/触发原因。每次都变,不标 cache。
    const temporalText = this.temporal.assemble(this.lastUserContact, this.lastWake)
    const triggerText = formatTrigger(trigger)

    const now = new Date()
    const timeHeader = `[时间锚点] 现在是 ${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}。回复中提到时间时必须以此为准,不要猜测。`

    const dynamicParts = [
      timeHeader,
      '',
      '--- 当前状态 ---',
      temporalText,
    ]

    if (this.episodic) {
      const episodicText = await this.episodic.assemble(currentInput)
      if (episodicText) {
        dynamicParts.push('')
        dynamicParts.push(episodicText)
      }
    }

    // L5 技能 / L6 知识,按需注入
    const proceduralText = this.procedural.assemble(currentInput)
    if (proceduralText) {
      dynamicParts.push('')
      dynamicParts.push(proceduralText)
    }
    const worldText = this.world.assemble(currentInput)
    if (worldText) {
      dynamicParts.push('')
      dynamicParts.push(worldText)
    }

    // Task 注入(按 trigger 分流,只读 active-tasks.json + 拼字符串,放动态段不击穿缓存前缀)。
    // 无 open task 时三个分支都不注入 —— 行为与纯被动逐字节相同。
    const taskText = this.assembleTaskContext(trigger)
    if (taskText) {
      dynamicParts.push('')
      dynamicParts.push(taskText)
    }

    // H2:已自动 blocked 但还没告知用户的 task,注入一次"请告知用户"提示(notified_blocked 去重)。
    // 放块2 动态段,无 blocked-未通知 task 时不注入,不击穿缓存前缀。
    const blockedText = this.assembleBlockedNotices()
    if (blockedText) {
      dynamicParts.push('')
      dynamicParts.push(blockedText)
    }

    dynamicParts.push('')
    dynamicParts.push('--- 本次唤醒原因 ---')
    dynamicParts.push(triggerText)

    systemBlocks.push({
      type: 'text',
      text: dynamicParts.join('\n'),
    })

    return {
      system: systemBlocks,
      tools: this.registeredTools,
    }
  }

  // 按 trigger 分流注入 Task 上下文。只读 active-tasks.json,无 open task 三分支均返空串。
  //  - self_scheduled 且 reason 命中某 task id → 注入该 task 全文(接着推这一个)
  //  - cron_fallback → 注入全部 open task 的一行摘要(她自己挑)
  //  - message → 一行"你有 N 个进行中任务"(不展开,省 token)
  private assembleTaskContext(trigger: WakeTrigger): string {
    if (trigger.type === 'self_scheduled') {
      const { tasks } = loadTasks(this.dataDir)
      // 只对仍可推进(open/in_progress)的 task 注入全文;命中的 task 若已 done/blocked 不注入
      const hit = tasks.find(t => trigger.reason.includes(t.id) && isOpenLike(t))
      return hit ? formatTaskFull(hit) : ''
    }
    if (trigger.type === 'cron_fallback') {
      const { tasks } = loadTasks(this.dataDir)
      return formatOpenTasksSummary(tasks)
    }
    if (trigger.type === 'message') {
      const { tasks } = loadTasks(this.dataDir)
      const n = countOpenTasks(tasks)
      return n > 0 ? `你有 ${n} 个进行中任务(需要详情用 task_list 查)。` : ''
    }
    return ''
  }

  // 已 blocked 但还没告知用户的 task → 一次性"请告知用户"提示。无则返空串(不注入)。
  // postProcess 在成功 cycle 后落 notified_blocked 去重,保证同一 task 只注入一次(防刷屏)。
  private assembleBlockedNotices(): string {
    return formatBlockedNotices(pendingBlockedNotices(loadTasks(this.dataDir)))
  }

  get streamLayer(): StreamLayer {
    return this.stream
  }

  get episodicLayer(): EpisodicLayer | null {
    return this.episodic
  }
}

function formatTrigger(trigger: WakeTrigger): string {
  switch (trigger.type) {
    case 'message':
      return `收到${trigger.message.sender.name}的消息`
    case 'self_scheduled':
      return `自己决定醒来: ${trigger.reason} (计划: ${trigger.activity_type})`
    case 'cron_fallback':
      return `被 cron 兜底唤醒: ${trigger.reason}`
    case 'system_event':
      return `系统事件: ${trigger.event}`
    case 'manual':
      return `手动唤醒: ${trigger.reason}`
    case 'webhook':
      return `外部事件: ${trigger.source}`
  }
}
