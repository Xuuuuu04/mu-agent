import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  trimHistory,
  extractMood,
  extractWakeDirective,
  extractStreamEntry,
  cleanResponse,
} from './agent-loop.js'
import type { ChatMessage, ContentBlock } from './types.js'

// ── 测试辅助 ──
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

// ════════ trimHistory:切点必须落纯文本 user,绝不留孤儿 tool_result(06-09 死亡螺旋根因)════════
test('trimHistory: 短历史返回同一引用(快路径)', () => {
  const h = [u('hi'), a('hello')]
  assert.equal(trimHistory(h, 40), h)
})

test('trimHistory: 长纯文本裁到上限内,首条是 user', () => {
  const h: ChatMessage[] = []
  for (let i = 0; i < 25; i++) h.push(u(`q${i}`), a(`a${i}`))
  const out = trimHistory(h, 40)
  assert.ok(out.length <= 40 && out.length >= 39)
  assert.ok(firstIsSafe(out))
})

test('trimHistory: 切点正好落 tool_result 时前移,无孤儿(对照:旧 slice 会产孤儿)', () => {
  const h: ChatMessage[] = [u('q0'), a('a0')]
  h.push(...toolPair('t1'))                          // idx 2=tool_use, 3=tool_result
  for (let i = 0; i < 39; i++) h.push(u(`后续${i}`))   // 43 条 → 切点 idx=3 是 tool_result
  const out = trimHistory(h, 40)
  assert.ok(noOrphans(out), '无孤儿')
  assert.ok(firstIsSafe(out), '首条 safe')
  assert.ok(!noOrphans(h.slice(-40)), '对照:旧 slice(-40) 确实产生孤儿')
})

test('trimHistory: 窗口内全是工具链,向前扩窗保完整链', () => {
  const h: ChatMessage[] = [u('一个超长任务')]
  for (let i = 0; i < 25; i++) h.push(...toolPair(`long${i}`))
  const out = trimHistory(h, 40)
  assert.ok(noOrphans(out))
  assert.ok(firstIsSafe(out))
})

// ════════ extractWakeDirective:[WAKE:秒:原因:活动] 容错(commit 8b4a674 WAKE 解析修复回归锁)════════
test('extractWake: 正常解析', () => {
  assert.deepEqual(extractWakeDirective('好的[WAKE:300:催饭:active]'),
    { seconds: 300, reason: '催饭', activity_type: 'active' })
})

test('extractWake: 未闭合 ] 仍解析成功', () => {
  assert.deepEqual(extractWakeDirective('[WAKE:300:催饭:active'),
    { seconds: 300, reason: '催饭', activity_type: 'active' })
})

test('extractWake: 缺 activity 段兜底 rest', () => {
  assert.equal(extractWakeDirective('[WAKE:600:消化下]')?.activity_type, 'rest')
})

test('extractWake: 核心事故案例 — reason 不贪婪吞过 ] 到下个 [MOOD', () => {
  const r = extractWakeDirective('[WAKE:300:催饭/active] [MOOD:calm:happy]')
  assert.equal(r?.reason, '催饭/active')          // 不能吃成 "催饭/active] [MOOD"
  assert.ok(!r!.reason.includes(']'))
})

test('extractWake: 无 [WAKE 返回 null', () => {
  assert.equal(extractWakeDirective('就是普通的一句话'), null)
})

// ════════ extractMood:[MOOD:情绪:原因] 容错 + enum ════════
test('extractMood: 正常解析', () => {
  assert.deepEqual(extractMood('[MOOD:excited:保研成功]'), { mood: 'excited', reason: '保研成功' })
})

test('extractMood: 缺 reason / 未闭合', () => {
  assert.deepEqual(extractMood('[MOOD:calm]'), { mood: 'calm', reason: '' })
  assert.equal(extractMood('[MOOD:sleepy:深夜')?.mood, 'sleepy')
})

test('extractMood: 6 种情绪 enum 各一,不漂移', () => {
  for (const e of ['calm', 'missing', 'emo', 'excited', 'sleepy', 'active']) {
    assert.equal(extractMood(`[MOOD:${e}:x]`)?.mood, e)
  }
})

test('[WAKE]+[MOOD] 连写不互吞', () => {
  const txt = '今天好累[WAKE:1800:睡觉:rest][MOOD:sleepy:困了]'
  assert.equal(extractWakeDirective(txt)?.reason, '睡觉')
  assert.equal(extractMood(txt)?.mood, 'sleepy')
})

// ════════ extractStreamEntry:清洗后判长度(纯指令→null,旧逻辑产生空白条目)════════
test('extractStreamEntry: 纯指令清洗后为空 → null', () => {
  assert.equal(extractStreamEntry('[WAKE:300:歇会:rest][MOOD:calm:还好]'), null)
})

test('extractStreamEntry: 有正文则抽出,截断在边界', () => {
  const r = extractStreamEntry('刚才看了会儿书,挺有意思的[WAKE:600:继续:rest]')
  assert.ok(r && r.content.includes('看了会儿书'))
  assert.ok(!r!.content.includes('[WAKE'))
})

// ════════ cleanResponse:抹掉内部指令 ════════
test('cleanResponse: 抹掉 WAKE/MOOD 留正文', () => {
  assert.equal(cleanResponse('在的呀[WAKE:300:等哥哥:active][MOOD:missing:想他]'), '在的呀')
})

test('cleanResponse: 未闭合标记也抹干净', () => {
  assert.equal(cleanResponse('好[WAKE:300:x'), '好')
})
