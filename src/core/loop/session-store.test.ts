import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionStore } from './session-store.js'
import type { ChatMessage, ContentBlock } from '../types.js'

const u = (text: string): ChatMessage => ({ role: 'user', content: text })
const a = (text: string): ChatMessage => ({ role: 'assistant', content: text })
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
function withStore(fn: (store: SessionStore, file: string) => void | Promise<void>): void | Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mu-ss-'))
  const file = join(dir, 'session.json')
  const cleanup = () => rmSync(dir, { recursive: true, force: true })
  try {
    const r = fn(new SessionStore(file), file)
    if (r instanceof Promise) return r.finally(cleanup)
    cleanup()
  } catch (e) { cleanup(); throw e }
}

test('push / length / buildMessages 裁剪到安全切点', () => withStore((s) => {
  for (let i = 0; i < 25; i++) { s.push(u(`q${i}`)); s.push(a(`a${i}`)) }
  assert.equal(s.length, 50)
  const msgs = s.buildMessages(40)
  assert.ok(msgs.length <= 40)
  assert.equal(msgs[0]!.role, 'user')
}))

test('clear 清空历史', () => withStore((s) => {
  s.push(u('hi'))
  s.clear()
  assert.equal(s.length, 0)
  // 注:sessionId 用 Date.now() 生成,同毫秒 clear 可能撞同一个 id(原行为),
  // 代次校验靠 history 长度/首元素第二道闸兜底,不单依赖 sessionId
}))

test('maybeRotate:空历史不轮转', () => withStore((s) => {
  let archived = false
  s.maybeRotate(0, () => { archived = true })
  assert.equal(archived, false)
}))

test('maybeRotate:未超时不轮转', () => withStore((s) => {
  s.push(u('hi'))
  let archived = false
  s.maybeRotate(10_000_000, () => { archived = true })
  assert.equal(archived, false)
  assert.equal(s.length, 1)
}))

test('maybeRotate:超时则归档(回调拿到旧历史)+ 清空换 id', () => withStore((s) => {
  const id0 = s.sessionId
  s.push(u('聊过的')); s.push(a('嗯'))
  let archivedHist: ChatMessage[] = []
  let archivedId = ''
  s.maybeRotate(0, (oldId, hist) => { archivedId = oldId; archivedHist = hist })
  assert.equal(archivedId, id0)
  assert.equal(archivedHist.length, 2)
  assert.equal(s.length, 0)
}))

test('maybeCompact:≤30 条不压缩', () => withStore(async (s) => {
  for (let i = 0; i < 20; i++) s.push(u(`q${i}`))
  await s.maybeCompact({ compactHistory: async () => '不该被调用' })
  assert.equal(s.length, 20)
}))

test('maybeCompact:>30 条头部压成前情提要', () => withStore(async (s) => {
  for (let i = 0; i < 40; i++) s.push(u(`q${i}`))
  await s.maybeCompact({ compactHistory: async () => '前面聊了很多' })
  assert.ok(s.length < 40, '压缩后变短')
  const msgs = s.buildMessages(100)
  assert.match(msgs[0]!.content as string, /前情提要/)
}))

test('maybeCompact:代次校验 — 压缩期间 clear,放弃 splice(不错接)', () => withStore(async (s) => {
  for (let i = 0; i < 40; i++) s.push(u(`q${i}`))
  let release = () => {}
  const gate = new Promise<void>(r => { release = r })
  const consolidation = { compactHistory: async () => { await gate; return '摘要' } }
  const p = s.maybeCompact(consolidation)   // 启动,挂在 compactHistory 上
  s.clear()                                  // 压缩中途换了 sessionId
  release()
  await p
  // 代次校验命中 → splice 被放弃,history 是 clear 后的状态
  assert.equal(s.length, 0)
  const msgs = s.buildMessages(100)
  assert.equal(msgs.length, 0)
}))

test('restore:剔孤儿 tool_result + trim;坏文件不崩', () => withStore((s, file) => {
  // 写一个开头是孤儿 tool_result 的落盘文件
  const bad: ChatMessage[] = [
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'lost', content: 'x' }] },
    a('嗯'), u('在吗'),
  ]
  writeFileSync(file, JSON.stringify({ sessionId: 's_old', lastActivity: 123, history: bad }))
  s.restore()
  const msgs = s.buildMessages(100)
  assert.ok(noOrphans(msgs), '孤儿被剔')
  assert.equal(s.sessionId, 's_old')
  assert.equal(s.lastActivity, 123)

  // 清理后文件应被覆写,下次重启不再重复告警(孤儿幽灵 fix)
  const persisted = JSON.parse(readFileSync(file, 'utf-8')) as { history: ChatMessage[] }
  assert.ok(noOrphans(persisted.history), '落盘文件里孤儿也被清掉了')

  // 坏 JSON 不崩
  writeFileSync(file, '{坏的')
  const s2 = new SessionStore(file)
  assert.doesNotThrow(() => s2.restore())
}))

test('persist / restore 往返', () => withStore((s, file) => {
  s.push(u('记住这句')); s.push(a('好的'))
  s.markActivity()
  s.persist()
  assert.ok(existsSync(file))
  const s2 = new SessionStore(file)
  s2.restore()
  assert.equal(s2.length, 2)
}))
