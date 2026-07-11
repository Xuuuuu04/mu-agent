// 多轮工具循环骨架,从 agent-loop.ts runCycle 抽出来的纯函数。主 cycle 和子代理共用同一份
// 容错真相:turns>0 预算守卫、无 tool_use 才判停、tool_result 失败回灌不中断、末轮纯指令回退
// (06-10 已读不回根因)、撞 maxTurns/budget/cancelled 带现有结果收尾。副作用全走回调——主 cycle 传
// session.push / streamLayer.append,子代理把 assistant/tool_result 累积进函数内局部数组(中间产物
// 不落主 session、不进意识流),onStreamEntry 子代理仍 noop。
// trimHistory 仍由调用方持有:主 cycle 的 rebuildMessages 走 session.buildMessages()(每轮裁剪),
// 循环体不直接碰 trimHistory。这些都是 06-09/06-10 事故换来的不变量,改这里先跑
// core/agent-loop.test.ts 全绿。
import type { AnthropicTool, ChatMessage, ContentBlock, ToolResult } from '../types.js'
import type { ModelRouter } from '../../providers/router.js'
import { log } from '../logger.js'
import { cleanResponse } from './directives.js'

export interface ToolLoopParams {
  system: string | ContentBlock[]
  messages: ChatMessage[]
  tools: AnthropicTool[]
  router: ModelRouter
  maxTurns: number
  budgetMs: number
  maxTokens: number
  thinking?: 'disabled'
  fallbackPolicy?: 'allow' | 'deny'
  abortSignal?: AbortSignal
  // 工具执行:内部已 try/catch,绝不抛(对标 ToolRegistry.execute)
  executeTool: (name: string, input: Record<string, unknown>) => Promise<ToolResult>
  // 只有调用方明确证明这一整组工具无副作用时才并行；默认串行。
  canExecuteInParallel?: (names: string[]) => boolean
  // assistant 内容入历史(主=session.push;子=noop)
  onAssistant?: (msg: ChatMessage) => void
  // tool_result 入历史(主=session.push;子=noop)
  onToolResult?: (msg: ChatMessage) => void
  // 意识流留备忘(主=streamLayer.append;子=noop,中间产物不落主意识流)
  onStreamEntry?: (entry: string, activityType?: string) => void
  // 每轮工具后重取消息(主=session.buildMessages() 含 trimHistory;省略则用循环内最近一次的快照)。
  // trimHistory 留在调用方(session-store),循环体不直接调它
  rebuildMessages?: () => ChatMessage[]
  // 外部取消信号(子代理超时用):每轮开头查(像 budget 守卫),为 true 则带现有结果收尾。
  // 主 cycle 不传=永不取消。这只能截在轮与轮之间,最坏多跑完当前这一轮 chat,不能掐底层 fetch。
  shouldCancel?: () => boolean
}

export interface ToolLoopResult {
  finalText: string
  lastSubstantive: string
  messages: ChatMessage[]
  turns: number
  usage: { input: number; output: number; cacheRead: number }
  toolCallCount: number
  stopReason: 'done' | 'max_turns' | 'budget' | 'cancelled'
}

// 不向上抛。chat 失败由调用方的 try/catch 接(主 cycle 的 3 连败自愈在 runCycle,不在这)。
export async function runToolLoop(p: ToolLoopParams): Promise<ToolLoopResult> {
  const start = Date.now()
  let messages = p.messages
  let turns = 0
  let finalText = ''
  let lastSubstantive = '' // 最近一轮去掉 WAKE/MOOD 指令后仍有内容的文本
  let totalInput = 0
  let totalOutput = 0
  let totalCacheRead = 0
  let toolCallCount = 0
  let stopReason: ToolLoopResult['stopReason'] = 'max_turns'

  while (turns < p.maxTurns) {
    // 外部取消(子代理超时):每轮开头查,带现有结果收尾。无 turns>0 条件——取消是无条件的,
    // 哪怕第一轮前就被取消也立刻停,不再起新一轮 chat。
    if (p.shouldCancel?.()) {
      stopReason = 'cancelled'
      break
    }
    if (turns > 0 && Date.now() - start > p.budgetMs) {
      console.warn(`[agent-loop] cycle 超时间预算(${Math.round((Date.now() - start) / 1000)}s),带现有结果收尾`)
      stopReason = 'budget'
      break
    }
    turns++

    const response = await p.router.chat({
      system: p.system,
      messages,
      tools: p.tools.length > 0 ? p.tools : undefined,
      max_tokens: p.maxTokens,
      thinking: p.thinking,
      fallbackPolicy: p.fallbackPolicy,
      signal: p.abortSignal,
    })

    totalInput += response.usage.input_tokens
    totalOutput += response.usage.output_tokens
    totalCacheRead += response.usage.cache_read_input_tokens ?? 0

    // chat 等待期间可能刚好超时/取消。返回的 tool_use 已经迟到，绝不能再执行副作用；
    // 这是子代理 timeout race 的最后一道物理闸。
    if (p.shouldCancel?.()) {
      stopReason = 'cancelled'
      break
    }

    const textBlocks = response.content.filter(b => b.type === 'text')
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use')

    if (textBlocks.length > 0) {
      finalText = textBlocks.map(b => b.text).join('')
      if (cleanResponse(finalText)) lastSubstantive = finalText
    }

    if (toolUseBlocks.length === 0) {
      // 存进会话历史前先抹掉 WAKE/MOOD 指令，否则模型下一轮看到自己上次的指令格式会复读。
      // 清洗后为空(纯指令轮)就不 push——正文已随带 tool 的轮存进历史,空 assistant 消息没价值
      const cleanedTurn = cleanResponse(finalText)
      if (cleanedTurn) p.onAssistant?.({ role: 'assistant', content: cleanedTurn })
      stopReason = 'done'
      break
    }

    p.onAssistant?.({ role: 'assistant', content: response.content })

    const executeBlock = async (block: ContentBlock): Promise<ContentBlock> => {
      toolCallCount++
      const toolStart = Date.now()
      const result = await p.executeTool(block.name!, block.input!)

      log.trace('tool', block.name ?? '?', {
        ok: result.success,
        ms: Date.now() - toolStart,
        error: result.success ? undefined : result.error,
      })

      // stream_note 等工具用 _stream_entry 给意识流留备忘 —— 这里是唯一的消费点,
      // 不接的话她调了 stream_note 也一条都落不了盘(06-09 连调 6 次全丢的事故)
      const se = (result as typeof result & {
        _stream_entry?: { content: string; activity_type?: string }
      })._stream_entry
      if (se?.content) {
        p.onStreamEntry?.(se.content, se.activity_type)
      }

      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: result.success ? result.output : `错误: ${result.error}`,
      }
    }

    let toolResults: ContentBlock[]
    const names = toolUseBlocks.map(b => b.name ?? '')
    if (toolUseBlocks.length > 1 && p.canExecuteInParallel?.(names)) {
      toolResults = await Promise.all(toolUseBlocks.map(executeBlock))
    } else {
      toolResults = []
      for (const block of toolUseBlocks) toolResults.push(await executeBlock(block))
    }

    p.onToolResult?.({ role: 'user', content: toolResults })
    messages = p.rebuildMessages ? p.rebuildMessages() : [...messages, { role: 'user', content: toolResults }]
  }

  // GLM 多轮工具后,最后一轮常只剩 [WAKE:...] 指令——finalText 被覆盖成纯指令,
  // 清洗后为空,中间轮生成的正文整段蒸发,用户视角"已读不回"(06-10 10:54 实锤:
  // 687 token 查了一堆去处,回复却是空)。回退:正文取最近的实质文本,指令保留给 postProcess
  if (!cleanResponse(finalText) && lastSubstantive) {
    const directives = finalText.match(/\[(?:WAKE|MOOD):[^\]\n]*\]?/g)?.join(' ') ?? ''
    console.warn('[agent-loop] 末轮只有指令无正文,回退到上一轮实质内容')
    finalText = directives ? `${lastSubstantive}\n${directives}` : lastSubstantive
  }

  return {
    finalText,
    lastSubstantive,
    messages,
    turns,
    usage: { input: totalInput, output: totalOutput, cacheRead: totalCacheRead },
    toolCallCount,
    stopReason,
  }
}
