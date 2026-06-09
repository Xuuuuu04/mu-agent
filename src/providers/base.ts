import type { ProviderConfig, AnthropicTool, ChatMessage, ContentBlock } from '../core/types.js'

export interface ChatParams {
  system: string | ContentBlock[]
  messages: ChatMessage[]
  tools?: AnthropicTool[]
  max_tokens?: number
  stop_sequences?: string[]
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
