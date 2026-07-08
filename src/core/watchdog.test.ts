import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Position } from './types.js'
import { WatchdogManager, checkTriggers, parseIfindPrices, type PriceFetcher, type Deliver } from './watchdog.js'

const pos = (over: Partial<Position>): Position => ({
  id: 'p1', code: '003816', name: '中国广核', qty: 100, cost: 3.87,
  stop_loss: 3.70, take_profit: 4.10, status: 'active', updated: '2026-07-08T00:00:00.000Z', ...over,
})

// ── checkTriggers ──
test('checkTriggers: 触止损(price ≤ 止损)', () => {
  const t = checkTriggers(pos({}), 3.65, 0.01)
  assert.equal(t.length, 1)
  assert.equal(t[0]!.type, 'stop_loss')
})

test('checkTriggers: 接近止损(止损 < price ≤ 止损×1.01)', () => {
  // 3.70*1.01=3.737;3.72 在 (3.70,3.737] → near
  const t = checkTriggers(pos({}), 3.72, 0.01)
  assert.equal(t.length, 1)
  assert.equal(t[0]!.type, 'stop_loss_near')
})

test('checkTriggers: 触止盈(price ≥ 止盈)', () => {
  const t = checkTriggers(pos({}), 4.15, 0.01)
  assert.equal(t.length, 1)
  assert.equal(t[0]!.type, 'take_profit')
})

test('checkTriggers: 接近止盈', () => {
  // 4.10*0.99=4.059;4.06 ≥ 4.059 且 < 4.10 → near
  const t = checkTriggers(pos({}), 4.06, 0.01)
  assert.equal(t.length, 1)
  assert.equal(t[0]!.type, 'take_profit_near')
})

test('checkTriggers: 安全区无触发', () => {
  assert.equal(checkTriggers(pos({}), 3.90, 0.01).length, 0)
})

test('checkTriggers: 没设止损止盈 → 空', () => {
  assert.equal(checkTriggers(pos({ stop_loss: undefined, take_profit: undefined }), 3.0, 0.01).length, 0)
})

// ── parseIfindPrices ──
test('parseIfindPrices: 解析 iFind real_time 嵌套 JSON', () => {
  const inner = { tables: [
    ['证券代码', '证券简称', 'time', '最新价', '涨跌幅'],
    ['003816.SZ', '中国广核', '2026-07-08 16:01:21', '3.88', '1.57'],
    ['600519.SH', '贵州茅台', '2026-07-08 16:01:09', '1199.3', '0.88'],
  ]}
  const outer = JSON.stringify({ code: 1, msg: 'success', data: JSON.stringify(inner) })
  const m = parseIfindPrices(outer)
  assert.equal(m.get('003816'), 3.88)
  assert.equal(m.get('600519'), 1199.3)
})

test('parseIfindPrices: 坏 JSON → 空 map 不抛', () => {
  assert.equal(parseIfindPrices('不是 json').size, 0)
  assert.equal(parseIfindPrices('{}').size, 0)
})

// ── WatchdogManager.tick ──
const MON_10_UTC = new Date('2026-01-05T02:00:00.000Z')   // 北京周一 10:00 = 盘中 morning
const SAT_10_UTC = new Date('2026-01-10T02:00:00.000Z')   // 北京周六 → 非交易

function withDir(positions: Position[] | null, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mu-wd-'))
  mkdirSync(join(dir, 'memory'), { recursive: true })
  if (positions) writeFileSync(join(dir, 'memory', 'portfolio.json'), JSON.stringify(positions))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

test('tick: 非交易日(周六)→ 不取价不告警', () => withDir([pos({})], async (dir) => {
  let fetched = 0
  const wd = new WatchdogManager({
    dataDir: dir,
    fetchPrices: async () => { fetched++; return new Map() },
    deliverToUser: async () => {},
    now: () => SAT_10_UTC,
  })
  await wd.tick()
  assert.equal(fetched, 0)
}))

test('tick: 非交易时段(pre_market 凌晨 / lunch / post_market)→ 跳过', () => withDir([pos({})], async (dir) => {
  let fetched = 0
  const fetcher = async () => { fetched++; return new Map() }
  // 北京周一 02:00(凌晨 pre_market)= UTC 周日 18:00
  const mon_02 = new Date('2026-01-04T18:00:00.000Z')
  // 北京周一 12:00(lunch)= UTC 04:00
  const mon_12 = new Date('2026-01-05T04:00:00.000Z')
  // 北京周一 16:00(post_market)= UTC 08:00
  const mon_16 = new Date('2026-01-05T08:00:00.000Z')
  for (const t of [mon_02, mon_12, mon_16]) {
    await new WatchdogManager({ dataDir: dir, fetchPrices: fetcher, deliverToUser: async () => {}, now: () => t }).tick()
  }
  assert.equal(fetched, 0, '凌晨/lunch/盘后都不该查价')
}))

test('tick: 无持仓 → 跳过', () => withDir([], async (dir) => {
  let fetched = 0
  const wd = new WatchdogManager({
    dataDir: dir,
    fetchPrices: async () => { fetched++; return new Map() },
    deliverToUser: async () => {},
    now: () => MON_10_UTC,
  })
  await wd.tick()
  assert.equal(fetched, 0)
}))

test('tick: 触止损 → 告警投递 + alerts.log + state 记冷却', () => withDir([pos({})], async (dir) => {
  const sent: string[] = []
  const wd = new WatchdogManager({
    dataDir: dir,
    fetchPrices: async (codes) => { const m = new Map(); m.set(codes[0]!, 3.65); return m }, // 触止损
    deliverToUser: async (t) => { sent.push(t) },
    now: () => MON_10_UTC,
  })
  await wd.tick()
  assert.equal(sent.length, 1)
  assert.match(sent[0]!, /触止损/)
  assert.match(sent[0]!, /中国广核/)
  // alerts.log 留底
  const log = readFileSync(join(dir, 'memory', 'alerts.log'), 'utf-8')
  assert.match(log, /触止损/)
  // state 落盘
  const st = JSON.parse(readFileSync(join(dir, 'memory', 'watchdog-state.json'), 'utf-8'))
  assert.ok(st.fired.includes('003816:stop_loss'))
}))

test('tick: 冷却 —— 同触发同日再 tick 不重复告警', () => withDir([pos({})], async (dir) => {
  const sent: string[] = []
  const wd = new WatchdogManager({
    dataDir: dir,
    fetchPrices: async (codes) => { const m = new Map(); m.set(codes[0]!, 3.65); return m },
    deliverToUser: async (t) => { sent.push(t) },
    now: () => MON_10_UTC,
  })
  await wd.tick()
  await wd.tick()
  await wd.tick()
  assert.equal(sent.length, 1, '同触发同日只告警一次')
}))

test('tick: 跨天 → 冷却清空,重新告警', () => withDir([pos({})], async (dir) => {
  const sent: string[] = []
  let day = MON_10_UTC
  const wd = new WatchdogManager({
    dataDir: dir,
    fetchPrices: async (codes) => { const m = new Map(); m.set(codes[0]!, 3.65); return m },
    deliverToUser: async (t) => { sent.push(t) },
    now: () => day,
  })
  await wd.tick()
  // 下一个交易日(周一+1=周二),同一只票应能再次告警
  day = new Date('2026-01-06T02:00:00.000Z') // 周二北京 10:00
  await wd.tick()
  assert.equal(sent.length, 2)
}))

test('tick: 取价失败 → 不告警不崩', () => withDir([pos({})], async (dir) => {
  const sent: string[] = []
  const wd = new WatchdogManager({
    dataDir: dir,
    fetchPrices: async () => { throw new Error('iFind 挂了') },
    deliverToUser: async (t) => { sent.push(t) },
    now: () => MON_10_UTC,
  })
  await wd.tick()
  assert.equal(sent.length, 0)
  assert.equal(existsSync(join(dir, 'memory', 'alerts.log')), false)
}))
