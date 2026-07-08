import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  beijingMinutes, beijingHour, beijingDateStr, beijingWeekday,
  isTradingDay, getMarketPhase, nextTradeSessionOpen, loadTradeCalendarFile,
  type TradeCalendar,
} from './market-hours.js'

// 北京时间 = UTC+8。所有 case 用 UTC 串构造已知北京时间,与系统时区解耦。
// 北京 X:00 = UTC (X-2):00。
const at = (utcIso: string) => new Date(utcIso)

// 镜像 data/memory/trade-calendar.json 的 2026 日历
const CAL: TradeCalendar = {
  version: 3,
  updated: '2026-07-07',
  valid_through: '2026-12-31',
  half_days: ['2026-09-30'],
  holidays: [
    '2026-01-01',
    '2026-02-16', '2026-02-17', '2026-02-18',
    '2026-04-06',
    '2026-05-01',
    '2026-06-19',
    '2026-09-25',
    '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08',
  ],
  extra_trade_days: [],
}

// ── 北京时间换算(UTC+8,不读系统时区)──
test('beijingMinutes: UTC 02:00 → 北京 10:00 = 600 分', () => {
  assert.equal(beijingMinutes(at('2026-01-05T02:00:00.000Z')), 600)
})

test('beijingHour: UTC 00:00 → 北京 08:00', () => {
  assert.equal(beijingHour(at('2026-01-05T00:00:00.000Z')), 8)
})

test('beijingDateStr: UTC 18:00(前一天)→ 北京次日 2026-01-05', () => {
  // UTC 2026-01-04T18:00 → 北京 2026-01-05T02:00,日期跨天
  assert.equal(beijingDateStr(at('2026-01-04T18:00:00.000Z')), '2026-01-05')
})

test('beijingWeekday: 2026-01-05 北京 = 周一(1)', () => {
  assert.equal(beijingWeekday(at('2026-01-05T02:00:00.000Z')), 1)
})

// ── isTradingDay ──
test('isTradingDay: 周一非休市 → true', () => {
  assert.equal(isTradingDay(at('2026-01-05T02:00:00.000Z'), CAL), true)
})

test('isTradingDay: 周六 → false(不跟调休补班)', () => {
  assert.equal(isTradingDay(at('2026-01-10T02:00:00.000Z'), CAL), false) // 2026-01-10 周六
})

test('isTradingDay: 周日 → false', () => {
  assert.equal(isTradingDay(at('2026-01-11T02:00:00.000Z'), CAL), false) // 2026-01-11 周日
})

test('isTradingDay: 法定假日(国庆 10-01,周四)→ false', () => {
  assert.equal(isTradingDay(at('2026-10-01T02:00:00.000Z'), CAL), false)
})

// ── getMarketPhase(交易日各时段)── 2026-01-05 周一
test('getMarketPhase: 09:20 → call_auction', () => {
  assert.equal(getMarketPhase(at('2026-01-05T01:20:00.000Z'), CAL), 'call_auction') // 北京 09:20
})

test('getMarketPhase: 09:40 → morning', () => {
  assert.equal(getMarketPhase(at('2026-01-05T01:40:00.000Z'), CAL), 'morning') // 北京 09:40
})

test('getMarketPhase: 12:00 → lunch', () => {
  assert.equal(getMarketPhase(at('2026-01-05T04:00:00.000Z'), CAL), 'lunch') // 北京 12:00
})

test('getMarketPhase: 14:00 → afternoon', () => {
  assert.equal(getMarketPhase(at('2026-01-05T06:00:00.000Z'), CAL), 'afternoon') // 北京 14:00
})

test('getMarketPhase: 16:00 → post_market', () => {
  assert.equal(getMarketPhase(at('2026-01-05T08:00:00.000Z'), CAL), 'post_market') // 北京 16:00
})

test('getMarketPhase: 08:00 → pre_market', () => {
  assert.equal(getMarketPhase(at('2026-01-05T00:00:00.000Z'), CAL), 'pre_market') // 北京 08:00
})

test('getMarketPhase: 周六全天 → closed', () => {
  assert.equal(getMarketPhase(at('2026-01-10T04:00:00.000Z'), CAL), 'closed') // 周六 12:00
})

test('getMarketPhase: 国庆假日 → closed', () => {
  assert.equal(getMarketPhase(at('2026-10-01T04:00:00.000Z'), CAL), 'closed')
})

// ── 半日市:2026-09-30 周三,仅上午 ──
test('getMarketPhase: 半日市上午(10:00)→ morning', () => {
  assert.equal(getMarketPhase(at('2026-09-30T02:00:00.000Z'), CAL), 'morning') // 北京 10:00
})

test('getMarketPhase: 半日市午后(14:00)→ closed', () => {
  assert.equal(getMarketPhase(at('2026-09-30T06:00:00.000Z'), CAL), 'closed') // 北京 14:00
})

// ── nextTradeSessionOpen ──
test('nextTradeSessionOpen: 周五盘后 → 下周一 09:30', () => {
  // 2026-01-09 周五 北京 16:00(UTC 08:00)→ 2026-01-12 周一 09:30(UTC 01:30)
  const open = nextTradeSessionOpen(at('2026-01-09T08:00:00.000Z'), CAL)
  assert.equal(open.toISOString(), '2026-01-12T01:30:00.000Z')
})

test('nextTradeSessionOpen: 当日未开盘 → 当日 09:30', () => {
  // 2026-01-05 周一 北京 08:00(UTC 00:00)→ 当日 09:30
  const open = nextTradeSessionOpen(at('2026-01-05T00:00:00.000Z'), CAL)
  assert.equal(open.toISOString(), '2026-01-05T01:30:00.000Z')
})

test('nextTradeSessionOpen: 节前半日市盘后 → 跨国庆长假到 10-09(20 天扫描内)', () => {
  // 2026-09-30 周三 北京 16:00(UTC 08:00)→ 国庆周全休 → 2026-10-09 周五 09:30
  const open = nextTradeSessionOpen(at('2026-09-30T08:00:00.000Z'), CAL)
  assert.equal(open.toISOString(), '2026-10-09T01:30:00.000Z')
})

// ── loadTradeCalendarFile:降级四路(缺失/JSON 坏/schema 坏/stale),绝不抛 ──
function calDir() {
  const dir = mkdtempSync(join(tmpdir(), 'shion-cal-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('loadTradeCalendarFile: 缺失 → null(不抛)', () => {
  const { dir, cleanup } = calDir()
  try {
    assert.equal(loadTradeCalendarFile(join(dir, 'nope.json')), null)
  } finally { cleanup() }
})

test('loadTradeCalendarFile: 坏 JSON → null', () => {
  const { dir, cleanup } = calDir()
  try {
    writeFileSync(join(dir, 'bad.json'), '{ 不是合法 json')
    assert.equal(loadTradeCalendarFile(join(dir, 'bad.json')), null)
  } finally { cleanup() }
})

test('loadTradeCalendarFile: schema 坏(holidays 非数组)→ null', () => {
  const { dir, cleanup } = calDir()
  try {
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ valid_through: '2026-12-31', holidays: 'x', half_days: [] }))
    assert.equal(loadTradeCalendarFile(join(dir, 'bad.json')), null)
  } finally { cleanup() }
})

test('loadTradeCalendarFile: stale(valid_through 已过)→ null', () => {
  const { dir, cleanup } = calDir()
  try {
    writeFileSync(join(dir, 'old.json'), JSON.stringify({ valid_through: '2020-01-01', holidays: [], half_days: [] }))
    assert.equal(loadTradeCalendarFile(join(dir, 'old.json')), null)
  } finally { cleanup() }
})

test('loadTradeCalendarFile: 合法 → 返回日历', () => {
  const { dir, cleanup } = calDir()
  try {
    const path = join(dir, 'cal.json')
    writeFileSync(path, JSON.stringify(CAL))
    const loaded = loadTradeCalendarFile(path)
    assert.ok(loaded)
    assert.deepEqual(loaded!.holidays, CAL.holidays)
    assert.deepEqual(loaded!.half_days, ['2026-09-30'])
  } finally { cleanup() }
})

test('无日历(传 null)也能推理:周末判非交易,平日判交易', () => {
  assert.equal(isTradingDay(at('2026-01-05T02:00:00.000Z'), null), true) // 周一
  assert.equal(isTradingDay(at('2026-01-10T02:00:00.000Z'), null), false) // 周六
  assert.equal(getMarketPhase(at('2026-01-10T04:00:00.000Z'), null), 'closed') // 周六 closed
})
