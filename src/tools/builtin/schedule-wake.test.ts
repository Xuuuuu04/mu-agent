import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scheduleWakeTool } from './schedule-wake.js'
import type { ToolContext } from '../../core/types.js'

type WakeCall = { seconds: number; reason: string; activity: string; semantics?: unknown }

// 捕获 scheduleWake 回调参数 + log
function makeCtx(opts: { withScheduler?: boolean } = {}): { ctx: ToolContext; calls: WakeCall[]; logs: string[] } {
  const calls: WakeCall[] = []
  const logs: string[] = []
  const ctx = {
    log: (m: string) => logs.push(m),
    scheduleWake: opts.withScheduler === false
      ? undefined
      : (seconds: number, reason: string, activity: string, semantics?: unknown) => calls.push({ seconds, reason, activity, semantics }),
  } as unknown as ToolContext
  return { ctx, calls, logs }
}

test('schedule_wake:正常调用 → 透传 seconds/reason/activity 给回调', async () => {
  const { ctx, calls, logs } = makeCtx()
  const r = await scheduleWakeTool.execute({ seconds: 300, reason: '消化一下', activity_type: 'learning' }, ctx)
  assert.equal(r.success, true)
  assert.equal(r.output, '好,300秒后醒来')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]!, { seconds: 300, reason: '消化一下', activity: 'learning', semantics: undefined })
  assert.ok(logs.some(l => l.includes('定了 300秒后醒')))
})

test('schedule_wake: target_at+weekday 结构化校验后透传语义', async () => {
  const { ctx, calls } = makeCtx()
  const now = Date.now
  Date.now = () => Date.parse('2026-07-12T00:00:00.000Z')
  try {
    const r = await scheduleWakeTool.execute({
      target_at: '2026-07-13T00:30:00.000Z', expected_weekday: 1,
      require_trading_day: true, reason: '周一 8:30 开盘前检查',
    }, ctx)
    assert.equal(r.success, true)
    assert.equal(calls[0]!.seconds, 88_200)
    assert.deepEqual(calls[0]!.semantics, {
      targetAt: '2026-07-13T00:30:00.000Z', expectedWeekday: 1, requireTradingDay: true,
    })
  } finally { Date.now = now }
})

test('schedule_wake: target_at 与 expected_weekday 冲突时拒绝入队', async () => {
  const { ctx, calls } = makeCtx()
  const r = await scheduleWakeTool.execute({
    target_at: '2026-07-13T00:30:00.000Z', expected_weekday: 2, reason: '冲突提醒',
  }, ctx)
  assert.equal(r.success, false)
  assert.match(r.error ?? '', /星期|周/)
  assert.equal(calls.length, 0)
})

test('schedule_wake:缺 activity_type → 默认 reminder(漏传不丢用户提醒)', async () => {
  // 这工具的本职是给用户做定时提醒;漏传 activity_type 时绝不能落成可被来消息打断的 rest。
  const { ctx, calls } = makeCtx()
  const r = await scheduleWakeTool.execute({ seconds: 60, reason: '提醒用户喝水' }, ctx)
  assert.equal(r.success, true)
  assert.equal(calls[0]!.activity, 'reminder')
})

test('schedule_wake:缺 reason → 空字符串(String(undefined ?? "") )', async () => {
  const { ctx, calls } = makeCtx()
  await scheduleWakeTool.execute({ seconds: 60 }, ctx)
  assert.equal(calls[0]!.reason, '')
})

test('schedule_wake:seconds 是数字字符串 → Number() 转换后照常', async () => {
  const { ctx, calls } = makeCtx()
  const r = await scheduleWakeTool.execute({ seconds: '120', reason: 'r' }, ctx)
  assert.equal(r.success, true)
  assert.equal(calls[0]!.seconds, 120)
})

test('schedule_wake:seconds <= 0 → 秒数不合法,不调回调', async () => {
  const { ctx, calls } = makeCtx()
  for (const bad of [0, -5]) {
    const r = await scheduleWakeTool.execute({ seconds: bad, reason: 'r' }, ctx)
    assert.equal(r.success, false)
    assert.equal(r.error, '秒数不合法')
  }
  assert.equal(calls.length, 0)
})

test('schedule_wake:seconds 非数字 (NaN) → 秒数不合法', async () => {
  const { ctx, calls } = makeCtx()
  const r = await scheduleWakeTool.execute({ seconds: 'abc', reason: 'r' }, ctx)
  assert.equal(r.success, false)
  assert.equal(r.error, '秒数不合法')
  assert.equal(calls.length, 0)
})

test('schedule_wake:Infinity → 不合法(!Number.isFinite)', async () => {
  const { ctx, calls } = makeCtx()
  const r = await scheduleWakeTool.execute({ seconds: Infinity, reason: 'r' }, ctx)
  assert.equal(r.success, false)
  assert.equal(r.error, '秒数不合法')
  assert.equal(calls.length, 0)
})

test('schedule_wake:无 ctx.scheduleWake → 调度器不可用(秒数合法但没调度器)', async () => {
  const { ctx } = makeCtx({ withScheduler: false })
  const r = await scheduleWakeTool.execute({ seconds: 100, reason: 'r' }, ctx)
  assert.equal(r.success, false)
  assert.equal(r.error, '调度器不可用')
})

test('schedule_wake:校验顺序 — 秒数先于调度器(seconds 非法时即便没调度器也报秒数)', async () => {
  const { ctx } = makeCtx({ withScheduler: false })
  const r = await scheduleWakeTool.execute({ seconds: 0, reason: 'r' }, ctx)
  assert.equal(r.error, '秒数不合法')
})
