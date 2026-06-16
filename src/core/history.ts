// 会话历史裁剪:切点必须落在"纯文本 user 消息"上。
// 硬 slice(-n) 会把 assistant 的 tool_use 和后面的 tool_result 切开,留下孤儿
// tool_result —— GLM 对此 400(2013 tool id not found),且坏历史驻留后每次请求都失败(06-09 事故根因)。
import type { ChatMessage } from './types.js'

export function trimHistory(history: ChatMessage[], max: number): ChatMessage[] {
  if (history.length <= max) return history
  let start = history.length - max
  while (start < history.length && !isSafeStart(history[start]!)) start++
  if (start >= history.length) {
    // 窗口内没有安全切点(超长工具链):向前扩窗到最近的安全点,宁可多带几条也不发坏历史
    start = history.length - max
    while (start > 0 && !isSafeStart(history[start]!)) start--
  }
  return history.slice(start)
}

// 安全切点:纯文本 user 消息,或不含 tool_result 的 user 消息
export function isSafeStart(m: ChatMessage): boolean {
  if (m.role !== 'user') return false
  if (typeof m.content === 'string') return true
  return !m.content.some(b => b.type === 'tool_result')
}
