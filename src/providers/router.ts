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

export interface RouterHealthSnapshot {
  last_selected_provider: string | null
  last_selected_role: 'primary' | 'fallback' | null
  primary_successes: number
  fallback_successes: number
  primary_failures: number
  fallback_failures: number
  total_failures: number
  last_success_at: string | null
  last_error: string | null
  last_error_provider: string | null
  last_error_at: string | null
}

export class ModelRouter {
  private primary: ModelProvider
  private fallbacks: ModelProvider[]
  // provider 级冷却:429/限流后跳过该 provider 直到冷却结束,防重试风暴
  private cooldowns = new Map<string, number>()
  private healthState: RouterHealthSnapshot = emptyRouterHealth()

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

  getHealthSnapshot(): RouterHealthSnapshot {
    return { ...this.ensureHealth() }
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    const { messages, dropped } = sanitizeMessages(params.messages)
    if (dropped.length > 0) {
      console.warn(`[router] 发送前剔除非法消息块: ${dropped.join('; ')}`)
      params = { ...params, messages }
    }

    const all = [this.primary, ...this.fallbacks]
    const fallbackAllowed = params.fallbackPolicy !== 'deny'
    const candidates = fallbackAllowed ? all : [this.primary]
    const providers = candidates.filter(p => this.isAvailable(p.name))
    if (providers.length === 0) {
      if (!fallbackAllowed) {
        const message = `primary provider ${this.primary.name} cooling down; fallback denied`
        this.recordRouteError(message, this.primary.name)
        throw new Error(message)
      }
      // 全部冷却中。原来这里 clear() 后立刻重打 = 单 provider 拓扑下冷却形同虚设,反而叠加内层重试成风暴。
      // 改为退避:抛出带最早恢复时间的错误,让调用方(cycle)这次失败(有自愈),别继续轰限流的 provider。
      const soonest = Math.min(...all.map(p => this.cooldowns.get(p.name) ?? Date.now()))
      const waitS = Math.max(0, Math.ceil((soonest - Date.now()) / 1000))
      const message = `all providers cooling down, retry in ${waitS}s`
      this.recordRouteError(message, null)
      throw new Error(message)
    }

    for (let i = 0; i < providers.length; i++) {
      const provider = providers[i]!
      const role = provider === this.primary ? 'primary' : 'fallback'
      try {
        const response = await provider.chat(params)
        this.recordSuccess(provider.name, role)
        return { ...response, provider: { name: provider.name, role } }
      } catch (err) {
        const msg = redactSecret((err as Error).message, provider.config.api_key)
        this.recordFailure(provider.name, role, msg)
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

  private ensureHealth(): RouterHealthSnapshot {
    // Object.create(ModelRouter.prototype) 的测试/兼容构造不会跑字段初始化,这里防御性补齐。
    if (!this.healthState) this.healthState = emptyRouterHealth()
    return this.healthState
  }

  private recordSuccess(provider: string, role: 'primary' | 'fallback'): void {
    const health = this.ensureHealth()
    if (role === 'primary') health.primary_successes++
    else health.fallback_successes++
    health.last_selected_provider = provider
    health.last_selected_role = role
    health.last_success_at = new Date().toISOString()
  }

  private recordFailure(provider: string, role: 'primary' | 'fallback', message: string): void {
    const health = this.ensureHealth()
    if (role === 'primary') health.primary_failures++
    else health.fallback_failures++
    health.total_failures++
    this.recordRouteError(message, provider)
  }

  private recordRouteError(message: string, provider: string | null): void {
    const health = this.ensureHealth()
    health.last_error = message
    health.last_error_provider = provider
    health.last_error_at = new Date().toISOString()
  }

  get primaryName(): string {
    return this.primary.name
  }
}

function emptyRouterHealth(): RouterHealthSnapshot {
  return {
    last_selected_provider: null,
    last_selected_role: null,
    primary_successes: 0,
    fallback_successes: 0,
    primary_failures: 0,
    fallback_failures: 0,
    total_failures: 0,
    last_success_at: null,
    last_error: null,
    last_error_provider: null,
    last_error_at: null,
  }
}

function redactSecret(message: string, secret: string): string {
  return secret ? message.split(secret).join('[REDACTED]') : message
}
