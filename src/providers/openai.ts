import type { ProviderConfig, ContentBlock, ChatMessage } from '../core/types.js'
import type { ModelProvider, ChatParams, ChatResponse } from './base.js'

// OpenAI 格式 provider(DeepSeek 等)。用原生 fetch,不引 openai SDK。
// 负责 Anthropic 内部格式 ↔ OpenAI chat/completions 格式的双向转换。
export function createOpenAIProvider(config: ProviderConfig): ModelProvider {
  const base = config.base_url.replace(/\/$/, '')
  const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`

  return {
    name: config.name,
    config,

    async chat(params: ChatParams): Promise<ChatResponse> {
      const messages = toOpenAIMessages(params.system, params.messages)
      const body: Record<string, unknown> = {
        model: config.model,
        max_tokens: params.max_tokens ?? config.max_tokens ?? 4096,
        messages,
      }
      if (config.temperature !== undefined) body.temperature = config.temperature
      // GLM openai 兼容端点支持 thinking.type 开关,寒暄消息禁推理省 30-60s
      if (params.thinking === 'disabled' && config.supports_thinking_control) {
        body.thinking = { type: 'disabled' }
      }
      if (params.tools && params.tools.length > 0) {
        body.tools = params.tools.map(t => ({
          type: 'function',
          // 清洗 schema:GLM 的 function-calling 严格,不接受 anyOf/format/property级required 等
          function: { name: t.name, description: t.description, parameters: sanitizeSchema(t.input_schema) },
        }))
      }
      if (params.stop_sequences) body.stop = params.stop_sequences

      const resp = await fetchWithRetry(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.api_key}`,
        },
        body: JSON.stringify(body),
      }, config.timeout_ms ?? 120000, config.name)

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '')
        throw new Error(`${config.name} HTTP ${resp.status}: ${errText.slice(0, 300)}`)
      }

      const data = await resp.json() as {
        id?: string
        choices?: Array<{
          message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }
          finish_reason?: string
        }>
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }

      const choice = data.choices?.[0]
      const msg = choice?.message
      const content: ContentBlock[] = []

      if (msg?.content) content.push({ type: 'text', text: msg.content })
      for (const tc of msg?.tool_calls ?? []) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: parseToolArgs(tc.function.arguments) })
      }
      if (content.length === 0) {
        // GLM 等推理模型把 max_tokens 全用在 reasoning 上时，content 空且无 tool_calls
        if (choice?.finish_reason === 'length') {
          console.warn(`[${config.name}] 输出被 max_tokens 截断且无内容(reasoning 吃光？把 max_tokens 调大)`)
        }
        content.push({ type: 'text', text: '' })
      }

      return {
        id: data.id ?? 'openai',
        content,
        stop_reason: choice?.finish_reason ?? null,
        usage: {
          input_tokens: data.usage?.prompt_tokens ?? 0,
          output_tokens: data.usage?.completion_tokens ?? 0,
        },
      }
    },
  }
}

// 清洗 JSON Schema,去掉 GLM function-calling 不接受的关键字。
// GLM 比 OpenAI 严格:anyOf/oneOf/allOf、format、additionalProperties、property 级的
// 非法 required(本该是 object 级数组)等都会让整个请求 400(code 1210)。
// 简化策略:anyOf/oneOf 取第一个非 null 分支提上来,删掉其余高级关键字。
function sanitizeSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema
  if (Array.isArray(schema)) return schema.map(sanitizeSchema)
  let s: Record<string, unknown> = { ...(schema as Record<string, unknown>) }

  // anyOf/oneOf:取第一个非 null 类型的分支,合并到当前层
  for (const key of ['anyOf', 'oneOf'] as const) {
    const arr = s[key]
    if (Array.isArray(arr)) {
      const branches = arr.filter(b => b && typeof b === 'object' && (b as Record<string, unknown>).type !== 'null')
      const chosen = sanitizeSchema(branches[0] ?? arr[0] ?? {}) as Record<string, unknown>
      delete s[key]
      s = { ...chosen, ...s }
      delete s[key]
    }
  }
  // allOf:合并所有分支
  if (Array.isArray(s.allOf)) {
    let merged: Record<string, unknown> = {}
    for (const b of s.allOf) merged = { ...merged, ...(sanitizeSchema(b) as Record<string, unknown>) }
    delete s.allOf
    s = { ...merged, ...s }
  }
  // 删掉 GLM 不认的关键字
  for (const k of ['format', 'additionalProperties', '$schema', '$ref', 'definitions', 'patternProperties']) {
    delete s[k]
  }
  // property 级的 required 必须是数组(object 级),不是数组就是写错了,删掉
  if ('required' in s && !Array.isArray(s.required)) delete s.required
  // const → enum(GLM 认 enum 不认 const)
  if ('const' in s) { s.enum = [s.const]; delete s.const }
  // 递归处理 properties 和 items
  if (s.properties && typeof s.properties === 'object') {
    const np: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(s.properties as Record<string, unknown>)) np[k] = sanitizeSchema(v)
    s.properties = np
  }
  if (s.items) s.items = sanitizeSchema(s.items)
  return s
}

// 解析 tool_call 的 arguments。容错中转站的怪格式(比如把 Claude 的 input 拼成 "{}{\"city\":\"北京\"}")。
function parseToolArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch { /* 下面容错 */ }
  // 拼接了多个 JSON 对象时(中转站怪格式)，括号配平切出每个完整对象，取最后一个非空的
  const frags = splitBalancedObjects(raw)
  for (let i = frags.length - 1; i >= 0; i--) {
    try {
      const o = JSON.parse(frags[i]!) as Record<string, unknown>
      if (Object.keys(o).length > 0) return o
    } catch { /* skip */ }
  }
  return {}
}

// 按花括号配平切出顶层 JSON 对象(忽略字符串字面量内的花括号)，
// 比扁平正则 /\{[^{}]*\}/ 能正确处理嵌套对象，不会丢外层键
function splitBalancedObjects(s: string): string[] {
  const out: string[] = []
  let depth = 0, start = -1, inStr = false, esc = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') { if (depth === 0) start = i; depth++ }
    else if (c === '}' && depth > 0) {
      depth--
      if (depth === 0 && start >= 0) { out.push(s.slice(start, i + 1)); start = -1 }
    }
  }
  return out
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// 带重试的 fetch：5xx/429/超时/网络错重试 2 次指数退避(429 读 Retry-After)。
// openai-format provider 是裸 fetch，没有 anthropic SDK 的内建重试，作 fallback 末位时尤其需要。
async function fetchWithRetry(url: string, init: RequestInit, timeoutMs: number, name: string): Promise<Response> {
  let lastErr: Error | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
      if ((resp.status >= 500 || resp.status === 429) && attempt < 2) {
        const ra = parseInt(resp.headers.get('retry-after') ?? '')
        await sleep(Number.isFinite(ra) ? ra * 1000 : 1000 * 2 ** attempt)
        continue
      }
      return resp
    } catch (e) {
      lastErr = e as Error
      if (attempt < 2) { await sleep(1000 * 2 ** attempt); continue }
    }
  }
  throw lastErr ?? new Error(`${name} 请求失败`)
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

function toOpenAIMessages(system: string | ContentBlock[], messages: ChatMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = []

  // system 可能是多 block(带 cache 标记),OpenAI 不支持,拼成一段纯文本
  const systemText = typeof system === 'string'
    ? system
    : system.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n\n')
  if (systemText) out.push({ role: 'system', content: systemText })

  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content })
      continue
    }

    // ContentBlock[]:可能是 assistant 的 text+tool_use,或 user 的 tool_result
    const textParts: string[] = []
    const toolCalls: OpenAIMessage['tool_calls'] = []
    const toolResults: OpenAIMessage[] = []

    for (const block of m.content) {
      if (block.type === 'text') {
        textParts.push(block.text ?? '')
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id ?? '',
          type: 'function',
          function: { name: block.name ?? '', arguments: JSON.stringify(block.input ?? {}) },
        })
      } else if (block.type === 'tool_result') {
        toolResults.push({
          role: 'tool',
          tool_call_id: block.tool_use_id ?? '',
          content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
        })
      }
    }

    if (m.role === 'assistant' && (textParts.length > 0 || toolCalls.length > 0)) {
      out.push({
        role: 'assistant',
        content: textParts.join('') || null,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      })
    }
    // tool_result 在 OpenAI 里是独立的 tool 消息
    out.push(...toolResults)
  }

  return out
}
