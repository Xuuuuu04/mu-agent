import Anthropic from '@anthropic-ai/sdk'
import type { ProviderConfig, ContentBlock } from '../core/types.js'
import type { ModelProvider, ChatParams, ChatResponse } from './base.js'

export function createAnthropicProvider(config: ProviderConfig): ModelProvider {
  const client = new Anthropic({
    apiKey: config.api_key,
    baseURL: config.base_url || undefined,
  })

  return {
    name: config.name,
    config,

    async chat(params: ChatParams): Promise<ChatResponse> {
      // string 和 ContentBlock[](带 cache_control)SDK 都接受，原样透传即可
      const systemContent = params.system

      const messages = params.messages.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }))

      const requestParams: Record<string, unknown> = {
        model: config.model,
        max_tokens: params.max_tokens ?? config.max_tokens ?? 4096,
        system: systemContent,
        messages,
      }
      if (config.temperature !== undefined) requestParams.temperature = config.temperature
      // 简单消息禁推理:GLM-5.1 的 reasoning 动辄 30-60s,寒暄不值得
      if (params.thinking === 'disabled' && config.supports_thinking_control) {
        requestParams.thinking = { type: 'disabled' }
      }

      if (params.tools && params.tools.length > 0) {
        const tools: Array<Record<string, unknown>> = params.tools.map(t => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema,
        }))
        // 给最后一个工具标 cache_control,整个 tools 块(106个工具 ~3万 token)被缓存,
        // 后续推理命中 cache,input 便宜一个量级。工具集稳定时这是最大的省钱点。
        if (config.supports_cache) {
          tools[tools.length - 1]!.cache_control = { type: 'ephemeral' }
        }
        requestParams.tools = tools
      }

      if (params.stop_sequences) {
        requestParams.stop_sequences = params.stop_sequences
      }

      const response = await client.messages.create(requestParams as unknown as Anthropic.MessageCreateParamsNonStreaming)

      const content: ContentBlock[] = []
      for (const block of response.content) {
        if (block.type === 'text') {
          content.push({ type: 'text', text: block.text })
        } else if (block.type === 'tool_use') {
          content.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          })
        }
        // 其他 block(thinking/redacted_thinking 等)跳过，不塞空 text 污染回复
      }
      if (content.length === 0) {
        if (response.stop_reason === 'max_tokens') {
          console.warn(`[${config.name}] 输出被 max_tokens 截断且无可用内容`)
        }
        content.push({ type: 'text', text: '' })
      }

      return {
        id: response.id,
        content,
        stop_reason: response.stop_reason,
        usage: {
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
          cache_read_input_tokens: (response.usage as unknown as Record<string, number>).cache_read_input_tokens,
        },
      }
    },
  }
}
