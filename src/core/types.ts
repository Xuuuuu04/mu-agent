export interface MuConfig {
  model: {
    primary: ProviderConfig
    fallback?: ProviderConfig[]
    auxiliary?: {
      vision?: ProviderConfig
      embedding?: ProviderConfig
      consolidation?: ProviderConfig
    }
  }
  scheduler: {
    min_wake_seconds: number
    max_wake_seconds: number
    cron_fallback_seconds: number
    night_min_wake_seconds: number
    night_start_hour: number
    night_end_hour: number
  }
  agent: {
    max_turns_per_cycle: number
    session_timeout_minutes: number
  }
  paths: {
    soul: string
    data: string
    tools: string
  }
  mcp?: McpServerConfig[]
  tools?: {
    web_search?: {
      provider: 'zhipu' | 'duckduckgo'
      api_key?: string
      base_url?: string
      // MiniMax Coding Plan 的 /v1/coding_plan/search(套餐内,与 fallback 模型同一把 sk-cp key)
      minimax_api_key?: string
      minimax_base_url?: string
    }
  }
  wechat?: {
    enabled: boolean
    host: string
    port: number
    token?: string
    self_wxid?: string
    // 独立 bridge 的主动发送接口。沐的主动消息 POST 到这里,bridge 转发到微信。
    bridge_send_url?: string
  }
  // QQ 是沐的主渠道(主动+被动)。沐的主动消息 POST 到 qq_bridge 的 /send。
  qq?: {
    bridge_send_url?: string
  }
  // HTTP 服务(webhook + Web 控制台)。默认绑回环 127.0.0.1，端口默认 3210。
  webhook?: {
    port?: number
  }
  proactive?: {
    enabled: boolean
    max_per_hour: number
    quiet_start_hour: number
    quiet_end_hour: number
  }
}

export interface McpServerConfig {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface ProviderConfig {
  name: string
  format: 'anthropic' | 'openai'
  base_url: string
  api_key: string
  model: string
  max_tokens?: number
  supports_cache?: boolean
  // 采样温度。人格类应用建议 0.8-1.0(更鲜活),不配则用 provider 默认
  temperature?: number
  // 端点支持 thinking.type 开关(GLM anthropic 端点),简单消息可禁推理提速
  supports_thinking_control?: boolean
  // openai-format provider 的请求超时(ms)，默认 120000；GLM 等推理模型可调大
  timeout_ms?: number
}

export type WakeTrigger =
  | { type: 'message'; message: IncomingMessage }
  | { type: 'self_scheduled'; reason: string; activity_type: string }
  | { type: 'cron_fallback'; reason: string }
  | { type: 'system_event'; event: string }
  | { type: 'webhook'; source: string; payload: unknown }
  | { type: 'manual'; reason: string }

export interface IncomingMessage {
  id: string
  source: 'wechat' | 'cli' | 'webhook'
  chat_type: 'private' | 'group'
  sender: { id: string; name: string }
  group?: { id: string; name: string }
  content: MessageContent
  timestamp: number
  is_mention?: boolean
  reply_to?: string
  // 群聊时附带的最近上下文(其他人的发言),供 agent 理解语境
  context?: string
}

export type MessageContent =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string; caption?: string }
  | { type: 'voice'; url: string; duration: number }
  | { type: 'file'; url: string; name: string }

export interface OutgoingMessage {
  target: { source: string; chat_id: string }
  content: MessageContent[]
  reply_to?: string
}

export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
  // 显式必填字段(MCP 工具用其 inputSchema.required)；没有则按 per-property required!==false 推断
  requiredKeys?: string[]
  execute: (params: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>
}

export interface ToolContext {
  config: MuConfig
  dataDir: string
  log: (msg: string) => void
  // 记忆库句柄(memory_search 检索对话历史用)
  store?: import('../memory/store.js').MemoryStore
  // 主动给用户发消息(message_send 用),路由到当前网关。imagePath 是本地图片,QQ 走富媒体
  sendMessage?: (text: string, imagePath?: string) => Promise<void>
  // 设置下次唤醒(schedule_wake 用)
  scheduleWake?: (seconds: number, reason: string, activityType: string) => void
}

export interface ToolResult {
  success: boolean
  output: string
  error?: string
}

export interface AgentResponse {
  text: string
  tool_calls?: ToolCall[]
  next_wake?: {
    seconds: number
    reason: string
    activity_type: string
  }
  stream_entry?: string
  mood_update?: {
    mood: Mood
    reason: string
  }
  memory_ops?: MemoryOp[]
}

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export type Mood = 'calm' | 'missing' | 'emo' | 'excited' | 'sleepy' | 'active'

export interface MoodState {
  current: Mood
  since: string
  reason: string
  previous?: { mood: Mood; changed_at: string }
}

export interface MemoryOp {
  type: 'save' | 'update' | 'forget'
  layer: 'facts' | 'commitments' | 'knowledge' | 'stream'
  key?: string
  content: string
}

export interface StreamEntry {
  timestamp: string
  content: string
  activity_type?: string
}

export interface Commitment {
  id: string
  content: string
  type: 'one-time' | 'recurring'
  schedule?: string
  due?: string
  status: 'active' | 'done' | 'cancelled'
  created: string
  last_done?: string
}

export interface AssembledContext {
  system: string
  messages: ChatMessage[]
  tools: AnthropicTool[]
  cache_breakpoints: number[]
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
}

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result'
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string
  cache_control?: { type: 'ephemeral' }
}

export interface AnthropicTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export interface CycleResult {
  response: string
  tool_calls_made: number
  tokens_used: { input: number; output: number; cache_read?: number }
  next_wake?: { seconds: number; reason: string }
  duration_ms: number
}

export interface GatewayAdapter {
  name: string
  connect(): Promise<void>
  disconnect(): Promise<void>
  onMessage(handler: (msg: IncomingMessage) => void): void
  send(msg: OutgoingMessage): Promise<void>
}
