import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzePortfolioRisk } from './portfolio-risk.js'

const positions = [
  { id: 'p1', code: 'AAA', name: '甲', qty: 10, cost: 8, stop_loss: 9, status: 'active' as const, updated: '2026-07-10T00:00:00.000Z' },
  { id: 'p2', code: 'BBB', name: '乙', qty: 20, cost: 1, stop_loss: 1.5, status: 'active' as const, updated: '2026-07-10T00:00:00.000Z' },
]

test('analyzePortfolioRisk: calculates P&L, weights, HHI, sectors and loss to stop deterministically', () => {
  const result = analyzePortfolioRisk(positions, {
    as_of: '2026-07-10T01:00:00.000Z',
    prices: { AAA: 12, BBB: 4 },
    sectors: { AAA: '消费', BBB: '金融' },
  }, { now: '2026-07-10T01:05:00.000Z', max_price_age_ms: 10 * 60_000 })

  assert.equal(result.snapshot_as_of, '2026-07-10T01:00:00.000Z')
  assert.equal(result.is_stale, false)
  assert.equal(result.total_market_value, 200)
  assert.equal(result.total_cost, 100)
  assert.equal(result.total_pnl, 100)
  assert.equal(result.total_return, 1)
  assert.equal(result.top_weight, 0.6)
  assert.equal(result.hhi, 0.52)
  assert.deepEqual(result.sector_weights, { '消费': 0.6, '金融': 0.4 })
  assert.equal(result.max_loss_to_stop, 80)
  assert.equal(result.positions[0]?.weight, 0.6)
  assert.equal(result.positions[0]?.return, 0.5)
  assert.deepEqual(result.warnings, [])
})

test('analyzePortfolioRisk: marks stale and missing prices, and excludes unknown values from totals', () => {
  const result = analyzePortfolioRisk(positions, {
    as_of: '2026-07-10T00:00:00.000Z', prices: { AAA: 12 },
  }, { now: '2026-07-10T01:00:00.000Z', max_price_age_ms: 15 * 60_000 })

  assert.equal(result.is_stale, true)
  assert.equal(result.total_market_value, 120)
  assert.equal(result.positions[1]?.price, null)
  assert.equal(result.positions[1]?.weight, null)
  assert.equal(result.warnings.some(warning => warning.type === 'stale_snapshot'), true)
  assert.equal(result.warnings.some(warning => warning.type === 'missing_price' && warning.code === 'BBB'), true)
})

test('analyzePortfolioRisk: zero known market value returns zero concentration with an incomplete warning', () => {
  const result = analyzePortfolioRisk([], {
    as_of: '2026-07-10T01:00:00.000Z', prices: {},
  }, { now: '2026-07-10T01:00:00.000Z' })

  assert.equal(result.total_market_value, 0)
  assert.equal(result.top_weight, 0)
  assert.equal(result.hhi, 0)
  assert.equal(result.total_return, 0)
  assert.equal(result.warnings.some(warning => warning.type === 'zero_total'), true)
})

test('analyzePortfolioRisk: missing stop is explicit instead of looking like zero stop risk', () => {
  const result = analyzePortfolioRisk([{ ...positions[0]!, stop_loss: undefined }], {
    as_of: '2026-07-10T01:00:00.000Z', prices: { AAA: 12 },
  }, { now: '2026-07-10T01:00:00.000Z' })

  assert.equal(result.max_loss_to_stop, 0)
  assert.equal(result.stop_covered_position_count, 0)
  assert.equal(result.is_complete, false)
  assert.equal(result.warnings.some(warning => warning.type === 'missing_stop' && warning.code === 'AAA'), true)
})

test('analyzePortfolioRisk: rejects negative/NaN quantity and price instead of coercing', () => {
  assert.throws(() => analyzePortfolioRisk([{ ...positions[0]!, qty: -1 }], {
    as_of: '2026-07-10T01:00:00.000Z', prices: { AAA: 12 },
  }, { now: '2026-07-10T01:00:00.000Z' }), /qty/)
  assert.throws(() => analyzePortfolioRisk(positions, {
    as_of: '2026-07-10T01:00:00.000Z', prices: { AAA: Number.NaN, BBB: 4 },
  }, { now: '2026-07-10T01:00:00.000Z' }), /price/)
})

test('analyzePortfolioRisk: rejects snapshots more than 60s in the future', () => {
  assert.throws(() => analyzePortfolioRisk(positions, {
    as_of: '2026-07-10T01:02:00.000Z', prices: { AAA: 12, BBB: 4 },
  }, { now: '2026-07-10T01:00:00.000Z' }), /future|clock skew/i)
})

test('analyzePortfolioRisk: tolerates up to 60s clock skew and reports age 0', () => {
  const result = analyzePortfolioRisk(positions, {
    as_of: '2026-07-10T01:00:30.000Z', prices: { AAA: 12, BBB: 4 },
  }, { now: '2026-07-10T01:00:00.000Z' })
  assert.equal(result.price_age_ms, 0)
  assert.equal(result.is_stale, false)
})
