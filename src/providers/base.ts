import type { ProviderConfig, AnthropicTool, ChatMessage, ContentBlock } from '../core/types.js'

export interface ChatParams {
  system: string | ContentBlock[]
  messages: ChatMessage[]
  tools?: AnthropicTool[]
  max_tokens?: number
  stop_sequences?: string[]
  // 'disabled' = 这轮不需要深度推理(寒暄/简单回应),推理模型跳过 thinking 直接答,
  // 延迟从 30-60s 降到几秒。只对配了 supports_thinking_control 的 provider 生效
  thinking?: 'disabled'
  // 调用方取消（子代理超时等），provider 必须尽快中止底层 HTTP。
  signal?: AbortSignal
}

export interface ChatResponse {
  id: string
  content: ContentBlock[]
  stop_reason: string | null
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number }
}

export interface ModelProvider {
  name: string
  config: ProviderConfig
  chat(params: ChatParams): Promise<ChatResponse>
}
