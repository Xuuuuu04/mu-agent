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
    max_sleep_seconds: number
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
    // image_gen 画图工具:ComfyUI host + 底模(都有工具内默认值,不配也能跑)
    image?: {
      host?: string
      checkpoint?: string
    }
    // 她的声音:voice_design 定制声线 + t2a。voice_send 工具用
    voice?: {
      voice_id: string
      api_key?: string
      base_url?: string
      model?: string
      speed?: number
    }
    // ima 知识库:Shion 自己维护(笔记写入)+ 检索(笔记 + 配置的 KB)。knowledge_write / memory_search 用
    ima?: {
      client_id: string
      api_key: string
      base_url?: string
      notebook?: string
      knowledge_bases?: { id: string; name: string }[]
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
  // 仅纯只读、互不依赖的工具可标记；同轮全部为 true 时运行时才并行。
  parallelSafe?: boolean
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
  // 子代理递归深度:主 cycle execute 传 0;子代理 subCtx 传 +1。spawn_subagent 据此 depth 硬闸(>=1 拒)
  depth?: number
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
  status: 'active' | 'done'
  created: string
  last_done?: string
  // 自我 review 相关(commitment_done 前对照 DoD 审一遍)
  definition_of_done?: string
  review_status?: 'passed' | 'failed'  // failed = 撞 2 轮上界强制放行,留痕
  review_rounds?: number               // 已自审轮数,上界 MAX_REVIEW_ROUNDS
}

// ── Task(多步骤、可 review、可跨多次自唤醒推进;区别于扁平的 Commitment)──
// 写盘前所有含时间的字段(title/dod/steps[].text/next_step/due)过 absolutizeTime
export type TaskStatus = 'open' | 'in_progress' | 'in_review' | 'blocked' | 'done'
export type TaskStepStatus = 'todo' | 'doing' | 'done'
export type ReviewVerdict = 'pass' | 'fail'

export interface TaskStep {
  id: string                  // `s${n}` task 内局部递增,稳定不复用
  text: string
  status: TaskStepStatus
}

export interface TaskReview {
  at: string                  // ISO
  verdict: ReviewVerdict
  note: string                // 哪条 DoD 没满足 / 为什么过
  by: 'self' | 'master'       // self-review pass 还是哥哥拍板
  scores?: Record<string, number>  // D3 多维 rubric 打分(可选)
}

export interface Task {
  id: string                  // `task_${Date.now().toString(36)}`
  title: string
  dod: string                 // 验收标准。空=未定义,进 in_review 前必须补
  status: TaskStatus
  source: { channel: 'wechat' | 'qq' | 'cli' | 'web' | 'self'; raw: string; at: string }
  steps: TaskStep[]           // 子任务拆解,可空
  deliverable?: string        // 产出物:文件路径/链接/结论文本
  review: TaskReview[]        // append-only;最后一条 verdict 决定能否 done
  // ── D2 有界控制字段(防自主循环失控,模型改不动)──
  next_step: string           // 下一步干什么,每轮自唤醒更新
  last_progress: string       // 给下次醒来当上下文
  wake_count: number          // 已自动唤醒推进几次(硬上限 MAX_WAKES_PER_TASK)
  fail_streak: number         // 连续"没进展"次数,驱动 backoff
  next_wake_at: string | null // 这个 task 的下次自唤醒绝对时刻
  blocked_reason: string | null
  created: string             // YYYY-MM-DD
  updated: string             // ISO
  due?: string                // YYYY-MM-DD
  // 自我 review 相关(置 done 前对照 DoD 审一遍,上界 MAX_REVIEW_ROUNDS 轮)
  review_rounds?: number      // 已自审轮数
  review_status?: 'passed' | 'failed'  // failed = 撞上界强制放行,留痕
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
