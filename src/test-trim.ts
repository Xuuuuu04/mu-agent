// trimHistory 的对照验证(手动跑: tsx src/test-trim.ts)
// 不变式:裁剪结果里 1) 不存在孤儿 tool_result 2) 首条是纯文本 user(或保留完整工具链)
import { trimHistory } from './core/history.js'
import type { ChatMessage, ContentBlock } from './core/types.js'

const u = (text: string): ChatMessage => ({ role: 'user', content: text })
const a = (text: string): ChatMessage => ({ role: 'assistant', content: text })
// 一对 tool_use + tool_result(各占一条消息)
const toolPair = (id: string): ChatMessage[] => [
  { role: 'assistant', content: [{ type: 'tool_use', id, name: 'x', input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
]

let failed = 0
function check(name: string, cond: boolean): void {
  console.log(`${cond ? '✓' : '✗'} ${name}`)
  if (!cond) failed++
}

// 不变式:每个 tool_result 引用的 id 必须在它之前的 tool_use 里出现过
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

// 1. 短历史原样返回
{
  const h = [u('hi'), a('hello')]
  check('短历史不裁剪', trimHistory(h, 40) === h)
}

// 2. 长纯文本历史:裁到 ≤max,首条 user
{
  const h: ChatMessage[] = []
  for (let i = 0; i < 25; i++) h.push(u(`q${i}`), a(`a${i}`))
  const out = trimHistory(h, 40)
  check('纯文本裁到上限内', out.length <= 40 && out.length >= 39)
  check('纯文本首条是 user', firstIsSafe(out))
}

// 3. 切点正好落在 tool_use 和 tool_result 之间:旧 slice(-40) 留孤儿,新逻辑必须跳过
{
  const h: ChatMessage[] = [u('q0'), a('a0')]
  h.push(...toolPair('t1'))                                  // 位置 2=tool_use, 3=tool_result
  for (let i = 0; i < 39; i++) h.push(u(`后续${i}`))          // 共 43 条 → 切点 idx=3,正好是 tool_result
  const out = trimHistory(h, 40)
  check('切点避开工具链:无孤儿', noOrphans(out))
  check('切点避开工具链:首条 safe', firstIsSafe(out))
  const legacy = h.slice(-40)
  check('(对照)旧 slice 确实会产生孤儿', !noOrphans(legacy))
}

// 4. 窗口内全是工具链:向前扩窗保住完整链
{
  const h: ChatMessage[] = [u('一个超长任务')]
  for (let i = 0; i < 25; i++) h.push(...toolPair(`long${i}`))  // 1 + 50 条
  const out = trimHistory(h, 40)
  check('全工具链窗口:无孤儿', noOrphans(out))
  check('全工具链窗口:首条 safe', firstIsSafe(out))
}

// 5. tool_result 后紧跟新 user 文本(常见形态)
{
  const h: ChatMessage[] = []
  for (let i = 0; i < 10; i++) {
    h.push(u(`q${i}`))
    h.push(...toolPair(`p${i}`))
    h.push(a(`done${i}`))
  }  // 40 条,再加几条触发裁剪
  h.push(u('new'), a('ok'))
  const out = trimHistory(h, 40)
  check('混合形态:无孤儿', noOrphans(out))
  check('混合形态:首条 safe', firstIsSafe(out))
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 个失败`)
process.exit(failed === 0 ? 0 : 1)
