import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trimHistory } from './history.js'
import type { ChatMessage, ContentBlock } from './types.js'

const u = (text: string): ChatMessage => ({ role: 'user', content: text })
const a = (text: string): ChatMessage => ({ role: 'assistant', content: text })
const toolPair = (id: string): ChatMessage[] => [
  { role: 'assistant', content: [{ type: 'tool_use', id, name: 'x', input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
]

// 不变式:每个 tool_result 引用的 id 必须在它之前的 tool_use 里出现过(无孤儿)
function noOrphans(msgs: ChatMessage[]): boolean {
  const seen = new Set<string>()
  for (const m of msgs) {
    if (typeof m.content === 'string') continue
    for (const b of m.content as ContentBlock[]) {
      if (b.type === 'tool_use' && b.id) seen.add(b.id)
      if (b.type === 'tool_result' && !seen.has(b.tool_use_id ?? '')) return false
    }
  }
  return true
}
function firstIsSafe(msgs: ChatMessage[]): boolean {
  const m = msgs[0]
  if (!m || m.role !== 'user') return false
  if (typeof m.content === 'string') return true
  return !(m.content as ContentBlock[]).some(b => b.type === 'tool_result')
}

// trimHistory:切点必须落纯文本 user,绝不留孤儿 tool_result(06-09 死亡螺旋根因)
test('短历史返回同一引用(快路径)', () => {
  const h = [u('hi'), a('hello')]
  assert.equal(trimHistory(h, 40), h)
})

test('长纯文本裁到上限内,首条是 user', () => {
  const h: ChatMessage[] = []
  for (let i = 0; i < 25; i++) h.push(u(`q${i}`), a(`a${i}`))
  const out = trimHistory(h, 40)
  assert.ok(out.length <= 40 && out.length >= 39)
  assert.ok(firstIsSafe(out))
})

test('切点正好落 tool_result 时前移,无孤儿(对照:旧 slice 会产孤儿)', () => {
  const h: ChatMessage[] = [u('q0'), a('a0')]
  h.push(...toolPair('t1'))
  for (let i = 0; i < 39; i++) h.push(u(`后续${i}`))
  const out = trimHistory(h, 40)
  assert.ok(noOrphans(out), '无孤儿')
  assert.ok(firstIsSafe(out), '首条 safe')
  assert.ok(!noOrphans(h.slice(-40)), '对照:旧 slice(-40) 确实产生孤儿')
})

test('窗口内全是工具链,向前扩窗保完整链', () => {
  const h: ChatMessage[] = [u('一个超长任务')]
  for (let i = 0; i < 25; i++) h.push(...toolPair(`long${i}`))
  const out = trimHistory(h, 40)
  assert.ok(noOrphans(out))
  assert.ok(firstIsSafe(out))
})
