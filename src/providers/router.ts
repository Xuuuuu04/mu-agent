import type { MuConfig, ProviderConfig } from '../core/types.js'
import type { ModelProvider, ChatParams, ChatResponse } from './base.js'
import { createAnthropicProvider } from './anthropic.js'
import { createOpenAIProvider } from './openai.js'
import { sanitizeMessages } from './sanitize-messages.js'

export function createProvider(config: ProviderConfig): ModelProvider {
  if (config.format === 'anthropic') return createAnthropicProvider(config)
  if (config.format === 'openai') return createOpenAIProvider(config)
  throw new Error(`unsupported format: ${config.format}`)
}

export class ModelRouter {
  private primary: ModelProvider
  private fallbacks: ModelProvider[]
  // provider 级冷却:429/限流后跳过该 provider 直到冷却结束,防重试风暴
  private cooldowns = new Map<string, number>()

  constructor(config: MuConfig) {
    this.primary = createProvider(config.model.primary)
    this.fallbacks = (config.model.fallback ?? []).map(c => createProvider(c))
  }

  // 单 provider 路由(整合等辅助任务用便宜模型时)
  static forProvider(config: ProviderConfig): ModelRouter {
    const r = Object.create(ModelRouter.prototype) as ModelRouter
    const rr = r as unknown as { primary: ModelProvider; fallbacks: ModelProvider[]; cooldowns: Map<string, number> }
    rr.primary = createProvider(config)
    rr.fallbacks = []
    rr.cooldowns = new Map()
    return r
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    const { messages, dropped } = sanitizeMessages(params.messages)
    if (dropped.length > 0) {
      console.warn(`[router] 发送前剔除非法消息块: ${dropped.join('; ')}`)
      params = { ...params, messages }
    }

    const all = [this.primary, ...this.fallbacks]
    const providers = all.filter(p => this.isAvailable(p.name))
    if (providers.length === 0) {
      // 全部冷却中。原来这里 clear() 后立刻重打 = 单 provider 拓扑下冷却形同虚设,反而叠加内层重试成风暴。
      // 改为退避:抛出带最早恢复时间的错误,让调用方(cycle)这次失败(有自愈),别继续轰限流的 provider。
      const soonest = Math.min(...all.map(p => this.cooldowns.get(p.name) ?? Date.now()))
      const waitS = Math.max(0, Math.ceil((soonest - Date.now()) / 1000))
      throw new Error(`all providers cooling down, retry in ${waitS}s`)
    }

    for (let i = 0; i < providers.length; i++) {
      const provider = providers[i]!
      try {
        return await provider.chat(params)
      } catch (err) {
        const msg = (err as Error).message
        const is429 = msg.includes('429') || msg.includes('1313')
        this.cooldowns.set(provider.name, Date.now() + (is429 ? 60_000 : 10_000))
        const isLast = i === providers.length - 1
        if (isLast) throw err
        console.error(`[router] ${provider.name} 挂了${is429 ? '(限流,冷却60s)' : ''},换下一个: ${msg}`)
      }
    }

    throw new Error('no providers available')
  }

  private isAvailable(name: string): boolean {
    const until = this.cooldowns.get(name)
    if (!until) return true
    if (Date.now() >= until) { this.cooldowns.delete(name); return true }
    return false
  }

  get primaryName(): string {
    return this.primary.name
  }
}
