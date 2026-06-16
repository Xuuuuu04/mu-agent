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

  private lastUserContact?: Date
  private lastWake?: { time: Date; activity: string }

  constructor(config: MuConfig, store?: MemoryStore, embedding?: EmbeddingService | null) {
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
    const streamText = this.stream.assemble()
    const triggerText = formatTrigger(trigger)

    const now = new Date()
    const timeHeader = `[时间锚点] 现在是 ${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}。回复中提到时间时必须以此为准,不要猜测。`

    const dynamicParts = [
      timeHeader,
      '',
      '--- 当前状态 ---',
      temporalText,
      '',
      '--- 意识流(你最近在做什么/想什么) ---',
      streamText,
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
