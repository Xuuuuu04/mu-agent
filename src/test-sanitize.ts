// sanitizeMessages 的对照验证(手动跑: tsx src/test-sanitize.ts)
// 不变式:输出里 1) 无孤儿 tool_result 2) 无"未被下一条 user 应答"的 tool_use 3) 干净输入原样返回
import { sanitizeMessages, hasOrphanToolBlocks } from './providers/sanitize-messages.js'
import type { ChatMessage, ContentBlock } from './core/types.js'

const u = (text: string): ChatMessage => ({ role: 'user', content: text })
const a = (text: string): ChatMessage => ({ role: 'assistant', content: text })
const toolPair = (id: string): ChatMessage[] => [
  { role: 'assistant', content: [{ type: 'tool_use', id, name: 'x', input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
]

let failed = 0
function check(name: string, cond: boolean): void {
  console.log(`${cond ? '✓' : '✗'} ${name}`)
  if (!cond) failed++
}

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

// 1. 纯文本:原样返回(同一引用,零开销快路径)
{
  const h = [u('hi'), a('hello')]
  const r = sanitizeMessages(h)
  check('纯文本原样返回', r.messages === h && r.dropped.length === 0)
}

// 2. 完整配对:原样返回
{
  const h = [u('q'), ...toolPair('t1'), a('done')]
  const r = sanitizeMessages(h)
  check('完整配对原样返回', r.messages === h && r.dropped.length === 0)
}

// 3. 06-09 事故形态:历史开头是孤儿 tool_result(裁剪把 tool_use 切掉了)
{
  const h: ChatMessage[] = [
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'lost', content: 'x' }] },
    a('嗯'), u('在吗'), a('在的'),
  ]
  const r = sanitizeMessages(h)
  check('孤儿 result 被剔且整条移除', r.messages.length === 3 && !hasOrphanToolBlocks(r.messages))
  check('孤儿 result 留下记录', r.dropped.some(d => d.includes('lost')))
}

// 4. 末尾 assistant 带无应答 tool_use(带 text):剔 block 保 text
{
  const h: ChatMessage[] = [u('q'), {
    role: 'assistant',
    content: [
      { type: 'text', text: '我查查' },
      { type: 'tool_use', id: 'pending', name: 'x', input: {} },
    ],
  }]
  const r = sanitizeMessages(h)
  const last = r.messages[r.messages.length - 1]!
  check('无应答 tool_use 被剔', noUnanswered(r.messages))
  check('同消息的 text 保住', typeof last.content !== 'string'
    && (last.content as ContentBlock[]).some(b => b.type === 'text' && b.text === '我查查'))
}

// 5. assistant 整条只有无应答 tool_use → 删条;其后引用它的 result 也连带成孤儿被删
{
  const h: ChatMessage[] = [
    u('q'),
    { role: 'assistant', content: [{ type: 'tool_use', id: 'b1', name: 'x', input: {} }] },
    a('插了一句话'),  // 把配对拆开:b1 的 result 不再紧邻
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'late' }] },
    a('ok'),
  ]
  const r = sanitizeMessages(h)
  check('拆开的配对两头都剔干净', !hasOrphanToolBlocks(r.messages) && noUnanswered(r.messages))
}

// 6. 多 tool_use 部分应答:只保留配对的
{
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
  check('部分应答:剔掉缺 result 的 use', noUnanswered(r.messages) && !hasOrphanToolBlocks(r.messages))
  check('部分应答:配对的保留', JSON.stringify(r.messages).includes('ok1'))
}

// 7. 长混合历史随机抽查:输出永远满足两个不变式
{
  const h: ChatMessage[] = [u('start')]
  for (let i = 0; i < 8; i++) h.push(...toolPair(`p${i}`), a(`r${i}`), u(`q${i}`))
  // 人为注入两处破坏
  h.splice(5, 1)   // 删掉某条 result
  h.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: '幽灵', content: '' }] })
  const r = sanitizeMessages(h)
  check('混合破坏:无孤儿', !hasOrphanToolBlocks(r.messages))
  check('混合破坏:无未应答', noUnanswered(r.messages))
  check('混合破坏:有剔除记录', r.dropped.length >= 2)
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 个失败`)
process.exit(failed === 0 ? 0 : 1)
