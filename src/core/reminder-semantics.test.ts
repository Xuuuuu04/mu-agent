import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateReminderSemantics, auditReminderText } from './reminder-semantics.js'
import type { TradeCalendar } from './market-hours.js'

const CAL: TradeCalendar = {
  valid_through: '2026-12-31', holidays: ['2026-10-01'], half_days: [],
}

test('structured reminder: 日期与星期一致时通过', () => {
  const result = validateReminderSemantics({
    targetAt: '2026-07-13T00:30:00.000Z', // 北京周一 08:30
    expectedWeekday: 1,
    requireTradingDay: true,
  }, CAL)
  assert.deepEqual(result.issues, [])
  assert.equal(result.beijingLocal, '2026-07-13 08:30')
})

test('structured reminder: 星期冲突与非交易日均 fail-closed', () => {
  const weekend = validateReminderSemantics({
    targetAt: '2026-07-11T00:30:00.000Z', expectedWeekday: 1, requireTradingDay: true,
  }, CAL)
  assert.deepEqual(weekend.issues.map(x => x.code), ['weekday_mismatch', 'not_trading_day'])
})

test('structured reminder: timezone-naive target is rejected independent of host TZ', () => {
  const result = validateReminderSemantics({ targetAt: '2026-07-13T09:00:00' })
  assert.equal(result.valid, false)
  assert.match(result.issues[0]!.message, /明确时区/)
})

test('legacy audit: 检出 reason 中周一/7月14日/8:30 与实际 at 三向冲突', () => {
  const result = auditReminderText(
    '2026-07-12T19:16:38.158Z',
    '周一(7/14)开盘前2小时(8:30)再次主动询问',
    CAL,
  )
  assert.equal(result.valid, false)
  assert.deepEqual(result.issues.map(x => x.code), ['weekday_mismatch', 'month_day_mismatch', 'time_mismatch'])
})
