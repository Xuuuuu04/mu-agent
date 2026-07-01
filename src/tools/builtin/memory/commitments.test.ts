// Characterization tests for commitments.ts — 锁 commitment_create / commitment_done 现在实际做什么。
// 临时 dataDir(mkdtempSync),finally 清理;ctx 只用到 dataDir + log。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { commitmentCreateTool, commitmentDoneTool } from './commitments.js'
import type { ToolContext, Commitment } from '../../../core/types.js'

// 临时 dataDir + 最小 ctx,跑完清理
function withCtx(fn: (ctx: ToolContext, dataDir: string) => void | Promise<void>): void | Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'mu-commit-'))
  const ctx = { dataDir, log: () => {} } as unknown as ToolContext
  const cleanup = () => rmSync(dataDir, { recursive: true, force: true })
  try {
    const r = fn(ctx, dataDir)
    if (r instanceof Promise) return r.finally(cleanup)
    cleanup()
  } catch (e) { cleanup(); throw e }
}

const commitFile = (dataDir: string) => join(dataDir, 'memory', 'commitments.json')

function readCommitments(dataDir: string): Commitment[] {
  return JSON.parse(readFileSync(commitFile(dataDir), 'utf-8'))
}
function seedCommitments(dataDir: string, rows: Commitment[]): void {
  mkdirSync(join(dataDir, 'memory'), { recursive: true })
  writeFileSync(commitFile(dataDir), JSON.stringify(rows, null, 2), 'utf-8')
}

// ── commitment_create ────────────────────────────────────────

test('commitment_create:文件不存在自动建,写一条 active 承诺', () => withCtx(async (ctx, dataDir) => {
  assert.equal(existsSync(commitFile(dataDir)), false)
  const r = await commitmentCreateTool.execute(
    { content: '帮哥哥订蛋糕', type: 'one-time', due: '2026-06-20' }, ctx)
  assert.equal(r.success, true)
  assert.match(r.output, /记下了: 帮哥哥订蛋糕/)
  const rows = readCommitments(dataDir)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.content, '帮哥哥订蛋糕')
  assert.equal(rows[0]!.type, 'one-time')
  assert.equal(rows[0]!.due, '2026-06-20')
  assert.equal(rows[0]!.status, 'active')
  assert.match(rows[0]!.created, /^\d{4}-\d{2}-\d{2}$/)
}))

test('commitment_create:id 格式 c{ts36},base36 时间戳', () => withCtx(async (ctx, dataDir) => {
  await commitmentCreateTool.execute({ content: 'A', type: 'one-time' }, ctx)
  const id = readCommitments(dataDir)[0]!.id
  assert.match(id, /^c[0-9a-z]+$/, 'id 形如 c + base36')
  // 去掉前缀能 parseInt(36) 还原成接近 now 的毫秒数
  const ts = parseInt(id.slice(1), 36)
  assert.ok(ts > 1_700_000_000_000, 'ts36 解回毫秒级时间戳')
  assert.ok(Math.abs(Date.now() - ts) < 60_000, '解出的时间戳接近当前时间')
}))

test('commitment_create:absolutizeTime 固化 content 里的"明天"', () => withCtx(async (ctx, dataDir) => {
  await commitmentCreateTool.execute({ content: '明天提醒哥哥吃药', type: 'one-time' }, ctx)
  const content = readCommitments(dataDir)[0]!.content
  assert.ok(!content.includes('明天'), '"明天"被固化成绝对日期')
  assert.match(content, /\d+月\d+日/)
}))

test('commitment_create:追加不覆盖已有承诺', () => withCtx(async (ctx, dataDir) => {
  seedCommitments(dataDir, [{
    id: 'cold', content: '旧承诺', type: 'one-time', status: 'active', created: '2026-06-01',
  }])
  await commitmentCreateTool.execute({ content: '新承诺', type: 'one-time' }, ctx)
  const rows = readCommitments(dataDir)
  assert.equal(rows.length, 2)
  assert.ok(rows.some(c => c.id === 'cold'), '旧承诺保留')
  assert.ok(rows.some(c => c.content === '新承诺'), '新承诺追加')
}))

test('commitment_create:recurring 类型带 schedule,due 可缺省为 undefined', () => withCtx(async (ctx, dataDir) => {
  await commitmentCreateTool.execute(
    { content: '每天中午提醒喝水', type: 'recurring', schedule: '每天中午' }, ctx)
  const c = readCommitments(dataDir)[0]!
  assert.equal(c.type, 'recurring')
  assert.equal(c.schedule, '每天中午')
  // JSON.stringify 丢掉 undefined,due 字段不落盘
  assert.ok(!('due' in c), '缺省 due 不写入 JSON')
}))

// ── commitment_done ──────────────────────────────────────────

test('commitment_done:文件不存在返回 error', () => withCtx(async (ctx) => {
  const r = await commitmentDoneTool.execute({ id: 'cwhatever' }, ctx)
  assert.equal(r.success, false)
  assert.equal(r.error, '没有承诺记录')
}))

test('commitment_done:id 找不到返回 error,文件不变', () => withCtx(async (ctx, dataDir) => {
  seedCommitments(dataDir, [{
    id: 'creal', content: '真实的', type: 'one-time', status: 'active', created: '2026-06-01',
  }])
  const r = await commitmentDoneTool.execute({ id: 'cnope' }, ctx)
  assert.equal(r.success, false)
  assert.match(r.error!, /找不到承诺 cnope/)
  assert.equal(readCommitments(dataDir)[0]!.status, 'active', '原承诺没动')
}))

test('commitment_done:one-time 完成置 status=done 并写 last_done', () => withCtx(async (ctx, dataDir) => {
  seedCommitments(dataDir, [{
    id: 'c1', content: '订蛋糕', type: 'one-time', status: 'active', created: '2026-06-01',
  }])
  const r = await commitmentDoneTool.execute({ id: 'c1' }, ctx)
  assert.equal(r.success, true)
  assert.match(r.output, /完成了: 订蛋糕/)
  const c = readCommitments(dataDir)[0]!
  assert.equal(c.status, 'done')
  assert.match(c.last_done!, /^\d{4}-\d{2}-\d{2}T/, 'last_done 是 ISO 时间戳')
}))

test('commitment_done(铁律):recurring 完成不置 done,只更新 last_done(下次还要做)', () => withCtx(async (ctx, dataDir) => {
  seedCommitments(dataDir, [{
    id: 'c2', content: '每天喝水', type: 'recurring', schedule: '每天', status: 'active', created: '2026-06-01',
  }])
  const r = await commitmentDoneTool.execute({ id: 'c2' }, ctx)
  assert.equal(r.success, true)
  const c = readCommitments(dataDir)[0]!
  assert.equal(c.status, 'active', 'recurring 完成后仍 active')
  assert.match(c.last_done!, /^\d{4}-\d{2}-\d{2}T/, 'last_done 被刷新')
}))

test('commitment_done:recurring 多次完成,last_done 持续刷新,status 始终 active', () => withCtx(async (ctx, dataDir) => {
  seedCommitments(dataDir, [{
    id: 'c3', content: '每天散步', type: 'recurring', status: 'active', created: '2026-06-01',
    last_done: '2026-06-10T00:00:00.000Z',
  }])
  await commitmentDoneTool.execute({ id: 'c3' }, ctx)
  const c = readCommitments(dataDir)[0]!
  assert.equal(c.status, 'active')
  assert.notEqual(c.last_done, '2026-06-10T00:00:00.000Z', 'last_done 被新时间覆盖')
}))

test('commitment_done:只动目标承诺,同文件其他承诺不受影响', () => withCtx(async (ctx, dataDir) => {
  seedCommitments(dataDir, [
    { id: 'ca', content: 'A', type: 'one-time', status: 'active', created: '2026-06-01' },
    { id: 'cb', content: 'B', type: 'one-time', status: 'active', created: '2026-06-01' },
  ])
  await commitmentDoneTool.execute({ id: 'cb' }, ctx)
  const rows = readCommitments(dataDir)
  assert.equal(rows.find(c => c.id === 'ca')!.status, 'active', 'A 不动')
  assert.equal(rows.find(c => c.id === 'cb')!.status, 'done', 'B 完成')
}))

test('commitment_create:非规范 type(如 once)归一化为 one-time,能被 done 标完成', () => withCtx(async (ctx, dataDir) => {
  // 修复前:type='once' 原样存,commitment_done 精确匹配 'one-time' 判死 → 永远标不了完成
  await commitmentCreateTool.execute({ content: '订蛋糕', type: 'once', due: '2026-07-05' }, ctx)
  const created = readCommitments(dataDir)
  assert.equal(created[0]!.type, 'one-time', 'once 被归一化成 one-time')
  const r = await commitmentDoneTool.execute({ id: created[0]!.id }, ctx)
  assert.equal(r.success, true)
  assert.equal(readCommitments(dataDir)[0]!.status, 'done', '能真正置 done,不再假报成功')
}))

test('commitment_create:周期性关键词(每天)归一化为 recurring', () => withCtx(async (ctx, dataDir) => {
  await commitmentCreateTool.execute({ content: '喝水', type: '每天', schedule: '每天' }, ctx)
  assert.equal(readCommitments(dataDir)[0]!.type, 'recurring')
}))

test('commitment_done:历史遗留非规范 type 也能标完成(!== recurring 兜底)', () => withCtx(async (ctx, dataDir) => {
  // 直接塞一条老数据,type 是非规范的 'onetime'
  seedCommitments(dataDir, [
    { id: 'cold', content: '老承诺', type: 'onetime' as unknown as Commitment['type'], status: 'active', created: '2026-06-01' },
  ])
  await commitmentDoneTool.execute({ id: 'cold' }, ctx)
  assert.equal(readCommitments(dataDir)[0]!.status, 'done')
}))
