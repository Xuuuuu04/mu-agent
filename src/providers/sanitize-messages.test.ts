import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeMessages, hasOrphanToolBlocks } from './sanitize-messages.js'
import type { ChatMessage, ContentBlock } from '../core/types.js'

// 锁住发送前最后防线:剔孤儿 tool_result / 无应答 tool_use(06-02~06-10 681 次 2013/1214 报错)
const u = (text: string): ChatMessage => ({ role: 'user', content: text })
const a = (text: string): ChatMessage => ({ role: 'assistant', content: text })
const toolPair = (id: string): ChatMessage[] => [
  { role: 'assistant', content: [{ type: 'tool_use', id, name: 'x', input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
]

// 不变式:每个 tool_use 必须被紧邻的下一条 user 消息应答
function noUnanswered(msgs: ChatMessage[]): boolean {
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]!
    if (m.role !== 'assistant' || typeof m.content === 'string') continue
    const uses = (m.content as ContentBlock[]).filter(b => b.type === 'tool_use')
    if (uses.length === 0) continue
    const next = msgs[i + 1]
    const answered = new Set<string>()
    if (next && next.role === 'user' && typeof next.content !== 'string') {
      for (const b of next.content as ContentBlock[]) {
        if (b.type === 'tool_result' && b.tool_use_id) answered.add(b.tool_use_id)
      }
    }
    if (uses.some(b => !answered.has(b.id ?? ''))) return false
  }
  return true
}

test('纯文本原样返回(同一引用,零开销快路径)', () => {
  const h = [u('hi'), a('hello')]
  const r = sanitizeMessages(h)
  assert.equal(r.messages, h)
  assert.equal(r.dropped.length, 0)
})

test('完整配对原样返回', () => {
  const h = [u('q'), ...toolPair('t1'), a('done')]
  const r = sanitizeMessages(h)
  assert.equal(r.messages, h)
  assert.equal(r.dropped.length, 0)
})

test('06-09 事故形态:开头孤儿 tool_result 整条移除', () => {
  const h: ChatMessage[] = [
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'lost', content: 'x' }] },
    a('嗯'), u('在吗'), a('在的'),
  ]
  const r = sanitizeMessages(h)
  assert.equal(r.messages.length, 3)
  assert.ok(!hasOrphanToolBlocks(r.messages))
  assert.ok(r.dropped.some(d => d.includes('lost')))
})

test('末尾 assistant 带无应答 tool_use:剔 block 保 text', () => {
  const h: ChatMessage[] = [u('q'), {
    role: 'assistant',
    content: [
      { type: 'text', text: '我查查' },
      { type: 'tool_use', id: 'pending', name: 'x', input: {} },
    ],
  }]
  const r = sanitizeMessages(h)
  const last = r.messages[r.messages.length - 1]!
  assert.ok(noUnanswered(r.messages))
  assert.ok(typeof last.content !== 'string'
    && (last.content as ContentBlock[]).some(b => b.type === 'text' && b.text === '我查查'))
})

test('拆开的配对两头都剔干净', () => {
  const h: ChatMessage[] = [
    u('q'),
    { role: 'assistant', content: [{ type: 'tool_use', id: 'b1', name: 'x', input: {} }] },
    a('插了一句话'),
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'late' }] },
    a('ok'),
  ]
  const r = sanitizeMessages(h)
  assert.ok(!hasOrphanToolBlocks(r.messages) && noUnanswered(r.messages))
})

test('多 tool_use 部分应答:只保留配对的', () => {
  const h: ChatMessage[] = [
    u('q'),
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'ok1', name: 'x', input: {} },
        { type: 'tool_use', id: 'missing', name: 'y', input: {} },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ok1', content: 'fine' }] },
    a('done'),
  ]
  const r = sanitizeMessages(h)
  assert.ok(noUnanswered(r.messages) && !hasOrphanToolBlocks(r.messages))
  assert.ok(JSON.stringify(r.messages).includes('ok1'))
})

test('长混合历史注入破坏:永远满足两不变式 + 有剔除记录', () => {
  const h: ChatMessage[] = [u('start')]
  for (let i = 0; i < 8; i++) h.push(...toolPair(`p${i}`), a(`r${i}`), u(`q${i}`))
  h.splice(5, 1)
  h.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: '幽灵', content: '' }] })
  const r = sanitizeMessages(h)
  assert.ok(!hasOrphanToolBlocks(r.messages))
  assert.ok(noUnanswered(r.messages))
  assert.ok(r.dropped.length >= 2)
})
