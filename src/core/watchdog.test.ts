import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Position } from './types.js'
import { WatchdogManager, checkTriggers, parseIfindPrices, parseIfindQuotePoints } from './watchdog.js'

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
  assert.deepEqual(parseIfindQuotePoints(outer).get('003816'), { price: 3.88, asOf: '2026-07-08T08:01:21.000Z' })
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
  writeFileSync(join(dir, 'memory', 'trade-calendar.json'), JSON.stringify({
    valid_through: '2099-12-31', holidays: [], half_days: [],
  }))
  if (positions) writeFileSync(join(dir, 'memory', 'portfolio.json'), JSON.stringify(positions))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

test('parseIfindPrices: 只接受 finite 且严格大于零的价格', () => {
  const inner = { tables: [
    ['证券代码', '最新价', 'time'],
    ['000001.SZ', '0', '2026-07-13 10:00:00'],
    ['000002.SZ', '-1', '2026-07-13 10:00:00'],
    ['000003.SZ', 'NaN', '2026-07-13 10:00:00'],
    ['000004.SZ', 'Infinity', '2026-07-13 10:00:00'],
    ['000005.SZ', '12.34', '2026-07-13 10:00:00'],
  ] }
  const prices = parseIfindPrices(JSON.stringify({ data: JSON.stringify(inner) }))
  assert.deepEqual([...prices.entries()], [['000005', 12.34]])
})

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

test('start: 启动后立即 tick 一次,不必等待首个 interval', () => withDir([pos({})], async (dir) => {
  let resolveFetched!: () => void
  const fetched = new Promise<void>((resolve) => { resolveFetched = resolve })
  let fetchCount = 0
  const wd = new WatchdogManager({
    dataDir: dir,
    fetchPrices: async () => {
      fetchCount++
      resolveFetched()
      return new Map([['003816', 3.90]])
    },
    deliverToUser: async () => {},
    now: () => MON_10_UTC,
    intervalSec: 3600,
  })

  wd.start()
  await fetched
  wd.stop()

  assert.equal(fetchCount, 1)
  assert.equal(wd.getHealthSnapshot().status, 'healthy')
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

test('tick: 双源一致才用共识价触发,并记录 quote quality', () => withDir([pos({})], async (dir) => {
  const sent: string[] = []
  const checks: Array<Record<string, unknown>> = []
  const wd = new WatchdogManager({
    dataDir: dir, fetchPrices: async () => new Map([['003816', 3.65]]),
    verifyPrices: async () => new Map([['003816', 3.651]]),
    recordQuoteCheck: value => { checks.push(value) },
    deliverToUser: async text => { sent.push(text) }, now: () => MON_10_UTC,
  })
  await wd.tick()
  assert.equal(sent.length, 1)
  assert.equal(wd.getHealthSnapshot().quote_verification, 'consistent')
  assert.equal(wd.getHealthSnapshot().verified_quote_count, 1)
  assert.equal(checks.length, 1)
}))

test('tick: 双源冲突时 fail closed,不以可疑主源触发告警', () => withDir([pos({})], async (dir) => {
  const sent: string[] = []
  const wd = new WatchdogManager({
    dataDir: dir, fetchPrices: async () => new Map([['003816', 3.65]]),
    verifyPrices: async () => new Map([['003816', 4.20]]),
    deliverToUser: async text => { sent.push(text) }, now: () => MON_10_UTC,
  })
  await wd.tick()
  assert.equal(sent.length, 0)
  assert.equal(wd.getHealthSnapshot().status, 'degraded')
  assert.equal(wd.getHealthSnapshot().quote_verification, 'divergent')
  assert.deepEqual(wd.getHealthSnapshot().missing_codes, ['003816'])
}))

test('tick: detailed sources use exchange timestamps and reject stale quotes', () => withDir([pos({})], async (dir) => {
  const wd = new WatchdogManager({ dataDir: dir,
    fetchPrices: async () => new Map(), verifyPrices: async () => new Map(),
    fetchQuotePoints: async () => new Map([['003816', { price: 3.65, asOf: '2026-01-05T01:59:00Z' }]]),
    verifyQuotePoints: async () => new Map([['003816', { price: 3.65, asOf: '2026-01-05T01:59:00Z' }]]),
    deliverToUser: async () => {}, now: () => MON_10_UTC })
  await wd.tick()
  assert.equal(wd.getHealthSnapshot().quote_verification, 'unavailable')
  assert.equal(wd.getHealthSnapshot().quote_count, 0)
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
  const health = wd.getHealthSnapshot()
  assert.equal(health.status, 'degraded')
  assert.equal(health.last_tick_at, MON_10_UTC.toISOString())
  assert.equal(health.last_success_at, null)
  assert.equal(health.quote_count, 0)
  assert.match(health.last_error ?? '', /iFind 挂了/)
  const persisted = JSON.parse(readFileSync(join(dir, 'memory', 'watchdog-health.json'), 'utf-8'))
  assert.deepEqual(persisted, health)
}))

test('tick: 活跃持仓返回空报价 → 记录 degraded,不能静默当成功', () => withDir([pos({})], async (dir) => {
  const wd = new WatchdogManager({
    dataDir: dir,
    fetchPrices: async () => new Map(),
    deliverToUser: async () => {},
    now: () => MON_10_UTC,
  })

  await wd.tick()

  const health = wd.getHealthSnapshot()
  assert.equal(health.status, 'degraded')
  assert.equal(health.active_position_count, 1)
  assert.equal(health.quote_count, 0)
  assert.deepEqual(health.missing_codes, ['003816'])
  assert.deepEqual(health.prices, {})
  assert.equal(health.as_of, null)
  assert.match(health.last_error ?? '', /missing quotes.*003816/i)
  assert.deepEqual(
    JSON.parse(readFileSync(join(dir, 'memory', 'watchdog-health.json'), 'utf-8')),
    health,
  )
}))

test('tick: 部分持仓缺报价 → 保留已有价格并记录缺失代码', () => withDir([
  pos({ code: '003816' }),
  pos({ id: 'p2', code: '600519', name: '贵州茅台' }),
], async (dir) => {
  const wd = new WatchdogManager({
    dataDir: dir,
    fetchPrices: async () => new Map([['003816', 3.90]]),
    deliverToUser: async () => {},
    now: () => MON_10_UTC,
  })

  await wd.tick()

  const health = wd.getHealthSnapshot()
  assert.equal(health.status, 'degraded')
  assert.equal(health.quote_count, 1)
  assert.deepEqual(health.prices, { '003816': 3.90 })
  assert.equal(health.as_of, MON_10_UTC.toISOString())
  assert.deepEqual(health.missing_codes, ['600519'])
  assert.equal(health.last_success_at, null)
}))

test('tick: 完整报价 → 健康快照包含价格与成功时间', () => withDir([pos({})], async (dir) => {
  const wd = new WatchdogManager({
    dataDir: dir,
    fetchPrices: async () => new Map([['003816', 3.90]]),
    deliverToUser: async () => {},
    now: () => MON_10_UTC,
  })

  await wd.tick()

  const health = wd.getHealthSnapshot()
  assert.deepEqual(health, {
    status: 'healthy',
    enabled: true,
    running: false,
    last_tick_at: MON_10_UTC.toISOString(),
    last_success_at: MON_10_UTC.toISOString(),
    active_position_count: 1,
    quote_count: 1,
    prices: { '003816': 3.90 },
    as_of: MON_10_UTC.toISOString(),
    missing_codes: [],
    last_error: null,
    last_error_at: null,
    skipped_reason: null,
    phase: 'morning',
    in_flight: false,
    next_tick_at: null,
    cadence_reason: null,
    effective_interval_seconds: null,
    overlap_suppressed: 0,
    quote_verification: 'not_configured',
    verified_quote_count: 0,
  })
  assert.doesNotThrow(() => JSON.stringify(health))
}))

test('lifecycle: 慢 tick 中 stop→start 不会遗留旧代 timer', () => withDir([pos({})], async (dir) => {
  let releaseFirst!: () => void
  let fetchCount = 0
  const wd = new WatchdogManager({
    dataDir: dir,
    intervalSec: 1,
    fetchPrices: async () => {
      fetchCount++
      if (fetchCount === 1) await new Promise<void>(resolve => { releaseFirst = resolve })
      return new Map([['003816', 3.90]])
    },
    deliverToUser: async () => {},
    now: () => MON_10_UTC,
  })
  wd.start()
  await new Promise(resolve => setImmediate(resolve))
  wd.stop()
  wd.start()
  releaseFirst()
  await new Promise(resolve => setTimeout(resolve, 1100))
  wd.stop()
  assert.equal(fetchCount, 2, '重启后只能有一条新代调度链')
}))

test('disabled: 不回放落盘的旧 healthy/in_flight/next_tick 运行态', () => withDir([pos({})], async (dir) => {
  writeFileSync(join(dir, 'memory', 'watchdog-health.json'), JSON.stringify({
    status: 'healthy', enabled: true, running: true, in_flight: true,
    next_tick_at: '2099-01-01T00:00:00.000Z', cadence_reason: 'stale',
  }))
  const wd = new WatchdogManager({
    dataDir: dir,
    enabled: false,
    fetchPrices: async () => new Map(),
    deliverToUser: async () => {},
  })
  wd.start()
  const health = wd.getHealthSnapshot()
  assert.equal(health.status, 'disabled')
  assert.equal(health.enabled, false)
  assert.equal(health.running, false)
  assert.equal(health.in_flight, false)
  assert.equal(health.next_tick_at, null)
  assert.equal(health.cadence_reason, null)
}))

test('start: 09:14:50 精确挂到 09:15,而非沿进程启动时刻固定漂移', () => withDir([pos({})], async (dir) => {
  const now = new Date('2026-01-05T01:14:50.000Z')
  const wd = new WatchdogManager({
    dataDir: dir,
    fetchPrices: async () => new Map(),
    deliverToUser: async () => {},
    now: () => now,
  })
  wd.start()
  await new Promise(resolve => setImmediate(resolve))
  const health = wd.getHealthSnapshot()
  wd.stop()
  assert.equal(health.phase, 'pre_market')
  assert.equal(health.next_tick_at, '2026-01-05T01:15:00.000Z')
  assert.equal(health.effective_interval_seconds, 10)
  assert.equal(health.cadence_reason, 'await_opening_auction')
  assert.equal(health.active_position_count, 1)
}))

test('tick: 慢报价未完成时拒绝重入,不会并发重复取价', () => withDir([pos({})], async (dir) => {
  let resolveFetch!: (value: Map<string, number>) => void
  let fetchCount = 0
  const wd = new WatchdogManager({
    dataDir: dir,
    fetchPrices: async () => {
      fetchCount++
      return await new Promise<Map<string, number>>(resolve => { resolveFetch = resolve })
    },
    deliverToUser: async () => {},
    now: () => MON_10_UTC,
  })
  const first = wd.tick()
  await new Promise(resolve => setImmediate(resolve))
  await wd.tick()
  assert.equal(fetchCount, 1)
  assert.equal(wd.getHealthSnapshot().overlap_suppressed, 1)
  resolveFetch(new Map([['003816', 3.90]]))
  await first
  assert.equal(wd.getHealthSnapshot().in_flight, false)
}))

test('tick: 配置的交易日历不可用 → 周末规则继续工作但健康状态降级', () => withDir([pos({})], async (dir) => {
  const wd = new WatchdogManager({
    dataDir: dir,
    calendarPath: join(dir, 'missing-calendar.json'),
    fetchPrices: async () => new Map([['003816', 3.90]]),
    deliverToUser: async () => {},
    now: () => MON_10_UTC,
  })

  await wd.tick()

  const health = wd.getHealthSnapshot()
  assert.equal(health.status, 'degraded')
  assert.equal(health.quote_count, 1, '日历降级不能破坏 watchdog 自愈取价')
  assert.match(health.last_error ?? '', /calendar/i)
}))

test('tick: calendarPath 缺省时读取 memory/trade-calendar.json,缺失则降级但继续取价', () => withDir([pos({})], async (dir) => {
  rmSync(join(dir, 'memory', 'trade-calendar.json'))
  let fetched = 0
  const wd = new WatchdogManager({
    dataDir: dir,
    fetchPrices: async () => { fetched++; return new Map([['003816', 3.90]]) },
    deliverToUser: async () => {},
    now: () => MON_10_UTC,
  })

  await wd.tick()

  assert.equal(fetched, 1)
  assert.equal(wd.getHealthSnapshot().status, 'degraded')
  assert.match(wd.getHealthSnapshot().last_error ?? '', /calendar/i)
}))

test('tick: 默认日历 corrupt/stale 都降级,不关闭工作日取价', async () => {
  for (const [label, calendar] of [
    ['corrupt', '{broken'],
    ['stale', JSON.stringify({ valid_through: '2000-01-01', holidays: [], half_days: [] })],
  ] as const) {
    await withDir([pos({})], async (dir) => {
      writeFileSync(join(dir, 'memory', 'trade-calendar.json'), calendar)
      let fetched = 0
      const wd = new WatchdogManager({
        dataDir: dir,
        fetchPrices: async () => { fetched++; return new Map([['003816', 3.90]]) },
        deliverToUser: async () => {},
        now: () => MON_10_UTC,
      })
      await wd.tick()
      assert.equal(fetched, 1, `${label} 日历应继续按 weekday fallback 取价`)
      assert.equal(wd.getHealthSnapshot().status, 'degraded', label)
    })
  }
})

test('tick: 非正数/非有限报价视为 missing,不触发止损告警', async () => {
  for (const price of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await withDir([pos({})], async (dir) => {
      const sent: string[] = []
      const wd = new WatchdogManager({
        dataDir: dir,
        fetchPrices: async () => new Map([['003816', price]]),
        deliverToUser: async text => { sent.push(text) },
        now: () => MON_10_UTC,
      })
      await wd.tick()
      const health = wd.getHealthSnapshot()
      assert.equal(health.status, 'degraded', `price=${price}`)
      assert.equal(health.quote_count, 0)
      assert.deepEqual(health.missing_codes, ['003816'])
      assert.equal(sent.length, 0)
      assert.equal(existsSync(join(dir, 'memory', 'alerts.log')), false)
    })
  }
})
