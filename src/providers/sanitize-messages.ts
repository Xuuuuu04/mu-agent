import type { ChatMessage, ContentBlock } from '../core/types.js'

// 发送前的最后防线:剔除孤儿 tool_result / 无应答 tool_use。
// trimHistory/autocompact 都保证切点正确,但历史上(06-02~06-10)孤儿 tool_result 造成过
// 681 次 2013/1214 报错——任何一个新代码路径搞坏历史,都会让坏 payload 永久驻留。
// 这里按配对语义兜底:tool_result 必须引用紧邻前一条 assistant 消息里的 tool_use,
// tool_use 必须被紧邻后一条 user 消息里的 tool_result 应答,否则剔掉对应 block。
export function sanitizeMessages(messages: ChatMessage[]): { messages: ChatMessage[]; dropped: string[] } {
  // 快路径:没有任何工具块就原样返回,不付重建开销
  const hasToolBlocks = messages.some(m =>
    typeof m.content !== 'string' && m.content.some(b => b.type === 'tool_use' || b.type === 'tool_result'))
  if (!hasToolBlocks) return { messages, dropped: [] }

  const dropped: string[] = []
  const out: ChatMessage[] = []

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    if (typeof m.content === 'string') { out.push(m); continue }

    if (m.role === 'assistant') {
      const uses = m.content.filter(b => b.type === 'tool_use')
      if (uses.length === 0) { out.push(m); continue }
      // tool_use 的应答只可能在紧邻的下一条 user 消息里
      const next = messages[i + 1]
      const answered = new Set<string>()
      if (next && next.role === 'user' && typeof next.content !== 'string') {
        for (const b of next.content) {
          if (b.type === 'tool_result' && b.tool_use_id) answered.add(b.tool_use_id)
        }
      }
      const keep = m.content.filter(b => b.type !== 'tool_use' || (b.id !== undefined && answered.has(b.id)))
      if (keep.length === m.content.length) { out.push(m); continue }
      for (const b of uses) {
        if (!(b.id !== undefined && answered.has(b.id))) dropped.push(`无应答 tool_use ${b.id}`)
      }
      if (keep.some(b => b.type !== 'text' || (b.text ?? '').length > 0)) {
        out.push({ ...m, content: keep })
      } else {
        dropped.push(`assistant 消息剔空,整条移除(原 ${m.content.length} 块)`)
      }
      continue
    }

    // user 消息:tool_result 的配对对象是"剔除后实际位于它前面"的那条 assistant
    // (用 out 的末条而非原始 messages[i-1]:前条 assistant 若刚被整条剔掉,这里的 result 就成了孤儿)
    const prev = out[out.length - 1]
    const prevUses = new Set<string>()
    if (prev && prev.role === 'assistant' && typeof prev.content !== 'string') {
      for (const b of prev.content) {
        if (b.type === 'tool_use' && b.id) prevUses.add(b.id)
      }
    }
    const keep = m.content.filter(b => b.type !== 'tool_result' || (b.tool_use_id !== undefined && prevUses.has(b.tool_use_id)))
    if (keep.length === m.content.length) { out.push(m); continue }
    for (const b of m.content) {
      if (b.type === 'tool_result' && !(b.tool_use_id !== undefined && prevUses.has(b.tool_use_id))) {
        dropped.push(`孤儿 tool_result ${b.tool_use_id}`)
      }
    }
    if (keep.some(b => b.type !== 'text' || (b.text ?? '').length > 0)) {
      out.push({ ...m, content: keep })
    } else {
      dropped.push(`user 消息剔空,整条移除(原 ${m.content.length} 块)`)
    }
  }

  return dropped.length > 0 ? { messages: out, dropped } : { messages, dropped }
}

// 校验用不变式(测试脚本/恢复会话时复用):每个 tool_result 引用的 id 都在它之前出现过
export function hasOrphanToolBlocks(messages: ChatMessage[]): boolean {
  const seen = new Set<string>()
  for (const m of messages) {
    if (typeof m.content === 'string') continue
    for (const b of m.content as ContentBlock[]) {
      if (b.type === 'tool_use' && b.id) seen.add(b.id)
      if (b.type === 'tool_result' && !seen.has(b.tool_use_id ?? '')) return true
    }
  }
  return false
}
