import type { MuConfig, ProviderConfig } from '../core/types.js'
import type { ModelProvider, ChatParams, ChatResponse } from './base.js'
import { createAnthropicProvider } from './anthropic.js'
import { createOpenAIProvider } from './openai.js'

export function createProvider(config: ProviderConfig): ModelProvider {
  if (config.format === 'anthropic') return createAnthropicProvider(config)
  if (config.format === 'openai') return createOpenAIProvider(config)
  throw new Error(`unsupported format: ${config.format}`)
}

export class ModelRouter {
  private primary: ModelProvider
  private fallbacks: ModelProvider[]

  constructor(config: MuConfig) {
    this.primary = createProvider(config.model.primary)
    this.fallbacks = (config.model.fallback ?? []).map(c => createProvider(c))
  }

  // 单 provider 路由(整合等辅助任务用便宜模型时)
  static forProvider(config: ProviderConfig): ModelRouter {
    const r = Object.create(ModelRouter.prototype) as ModelRouter
    ;(r as unknown as { primary: ModelProvider; fallbacks: ModelProvider[] }).primary = createProvider(config)
    ;(r as unknown as { primary: ModelProvider; fallbacks: ModelProvider[] }).fallbacks = []
    return r
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    const providers = [this.primary, ...this.fallbacks]

    for (let i = 0; i < providers.length; i++) {
      const provider = providers[i]!
      try {
        return await provider.chat(params)
      } catch (err) {
        const isLast = i === providers.length - 1
        if (isLast) throw err
        console.error(`[router] ${provider.name} 挂了,换下一个: ${(err as Error).message}`)
      }
    }

    throw new Error('no providers available')
  }

  get primaryName(): string {
    return this.primary.name
  }
}
