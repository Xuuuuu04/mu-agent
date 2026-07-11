import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  reconcileQuotes, mergeMarketEvents, calculateValuationSnapshot,
  attributePortfolio, evaluateDecisionOutcome, evaluateMarketSession,
  ResearchIntelligenceStore,
} from './research-intelligence.js'

test('reconcileQuotes: 两个新鲜来源一致形成 quorum,异常源不污染中位数', () => {
  const now = new Date('2026-07-13T02:00:10.000Z')
  const result = reconcileQuotes([
    { source: 'ifind', price: 10.00, asOf: '2026-07-13T02:00:09.000Z' },
    { source: 'tencent', price: 10.01, asOf: '2026-07-13T02:00:08.000Z' },
    { source: 'bad', price: 99, asOf: '2026-07-13T02:00:09.000Z' },
  ], now, { maxAgeSeconds: 15, toleranceBps: 20, minSources: 2 })
  assert.equal(result.status, 'divergent')
  assert.equal(result.consensusPrice, 10.01)
  assert.deepEqual(result.acceptedSources, ['ifind', 'tencent'])
  assert.deepEqual(result.rejectedSources, ['bad'])
})

test('reconcileQuotes: stale/非法价格被拒,单源只能 degraded', () => {
  const result = reconcileQuotes([
    { source: 'ifind', price: 10, asOf: '2026-07-13T02:00:00.000Z' },
    { source: 'tencent', price: Number.NaN, asOf: '2026-07-13T02:00:09.000Z' },
  ], new Date('2026-07-13T02:00:10.000Z'), { maxAgeSeconds: 5, toleranceBps: 20, minSources: 2 })
  assert.equal(result.status, 'unavailable')
  assert.equal(result.consensusPrice, null)
})

test('reconcileQuotes: duplicate source cannot manufacture quorum', () => {
  const result = reconcileQuotes([
    { source: 'same', price: 10, asOf: '2026-07-13T02:00:09Z' },
    { source: 'same', price: 10, asOf: '2026-07-13T02:00:09Z' },
  ], new Date('2026-07-13T02:00:10Z'), { maxAgeSeconds: 5, toleranceBps: 20, minSources: 2 })
  assert.equal(result.status, 'degraded')
  assert.deepEqual(result.acceptedSources, ['same'])
})

test('mergeMarketEvents: 规范化、去重、严重度和持仓关联', () => {
  const events = mergeMarketEvents([], [
    { source: 'cninfo', title: '600519 关于重大资产重组停牌公告', publishedAt: '2026-07-13T01:00:00Z', url: 'https://x/a' },
    { source: 'cninfo', title: '600519 关于重大资产重组停牌公告', publishedAt: '2026-07-13T01:00:00Z', url: 'https://x/a' },
    { source: 'news', title: '行业普通快讯', publishedAt: '2026-07-13T01:01:00Z' },
  ], ['600519'])
  assert.equal(events.length, 2)
  assert.equal(events[0]!.severity, 'critical')
  assert.deepEqual(events[0]!.relatedCodes, ['600519'])
  assert.equal(events[0]!.requiresAlert, true)
})

test('calculateValuationSnapshot: 计算前向PE/PEG并保留情景假设和覆盖度', () => {
  const v = calculateValuationSnapshot({
    code: '600519', asOf: '2026-07-13T07:00:00Z', price: 1200,
    epsTtm: 60, bookValuePerShare: 220, forwardEps: 70, nextForwardEps: 80,
    analystCount: 18, targetPe: { bear: 15, base: 20, bull: 25 },
    evidence: {
      price: { source: 'tencent', asOf: '2026-07-13T07:00:00Z' }, epsTtm: { source: 'annual-report', asOf: '2026-04-01T00:00:00Z' },
      bookValuePerShare: { source: 'annual-report', asOf: '2026-04-01T00:00:00Z' }, forwardEps: { source: 'ifind-consensus', asOf: '2026-07-12T00:00:00Z' },
      nextForwardEps: { source: 'ifind-consensus', asOf: '2026-07-12T00:00:00Z' },
    },
  })
  assert.equal(v.peTtm, 20)
  assert.equal(v.pb, 5.45)
  assert.equal(v.forwardPe, 17.14)
  assert.equal(v.peg, 1.2)
  assert.deepEqual(v.scenarioValues, { bear: 1050, base: 1400, bull: 1750 })
  assert.equal(v.coverage, 'high')
  assert.equal(v.evidenceCoverage.price!.status, 'available')
})

test('valuation/outcome/session reject internally inconsistent or non-finite evidence', () => {
  assert.throws(() => calculateValuationSnapshot({ code: '600519', asOf: '2026-07-13T07:00:00Z', price: 10,
    analystCount: Number.NaN, targetPe: { bear: 30, base: 20, bull: 10 }, evidence: {} }), /target PE scenarios|analyst count/)
  assert.throws(() => evaluateDecisionOutcome({ action: 'buy', decisionPrice: 10, benchmarkPrice: 100,
    observedPrice: 12, observedBenchmark: 105, high: 11, low: 9 }), /price range/)
  assert.throws(() => evaluateMarketSession({ date: '2026-07-13', expected: ['09:15'], observed: [],
    quoteCoverage: Number.NaN, overlapSuppressed: 0 }), /invalid session audit/)
})

test('valuation exposes field-level missing/stale evidence and rejects future evidence', () => {
  const stale = calculateValuationSnapshot({ code: '600519', asOf: '2026-07-13T07:00:00Z', price: 10, forwardEps: 1,
    targetPe: { bear: 8, base: 10, bull: 12 }, analystCount: 12, evidence: {
      price: { source: 'tencent', asOf: '2026-07-13T06:59:00Z' }, forwardEps: { source: 'old-consensus', asOf: '2025-01-01T00:00:00Z' },
    } })
  assert.equal(stale.coverage, 'degraded')
  assert.equal(stale.evidenceCoverage.forwardEps!.status, 'stale')
  assert.equal(stale.evidenceCoverage.epsTtm!.status, 'missing')
  assert.throws(() => calculateValuationSnapshot({ code: '600519', asOf: '2026-07-13T07:00:00Z', price: 10,
    targetPe: { bear: 8, base: 10, bull: 12 }, evidence: { price: { source: 'x', asOf: '2026-07-14T00:00:00Z' } } }), /future/)
  const priceOnly = calculateValuationSnapshot({ code: '600519', asOf: '2026-07-13T07:00:00Z', price: 10, analystCount: 20,
    targetPe: { bear: 8, base: 10, bull: 12 }, evidence: { price: { source: 'x', asOf: '2026-07-13T07:00:00Z' } } })
  assert.equal(priceOnly.coverage, 'low')
})

test('attributePortfolio: 持仓与行业贡献之和可解释,费用单列', () => {
  const a = attributePortfolio({ startEquity: 100000, actualEndEquity: 100700, netCashFlow: 0,
    benchmarkReturn: 0.01, fees: 100, slippage: 0, positions: [
    { code: 'A', sector: '白酒', qty: 100, startPrice: 100, endPrice: 110 },
    { code: 'B', sector: '银行', qty: 1000, startPrice: 10, endPrice: 9.8 },
  ] })
  assert.equal(a.grossPnl, 800)
  assert.equal(a.netPnl, 700)
  assert.equal(a.netReturn, 0.007)
  assert.equal(a.excessReturn, -0.003)
  assert.deepEqual(a.sectorPnl, { 白酒: 1000, 银行: -200 })
  assert.deepEqual(a.positionWeights, { A: 0.1, B: 0.1 })
  assert.deepEqual(a.sectorExposure, { 白酒: 0.1, 银行: 0.1 })
  assert.equal(a.cashWeight, 0.8)
  assert.deepEqual(a.reconciliation, { positionPnlSum: 800, feeEffect: -100, slippageEffect: 0, residualPnl: 0, status: 'balanced' })
  const mismatch = attributePortfolio({ startEquity: 100000, actualEndEquity: 100750, netCashFlow: 0,
    benchmarkReturn: 0, fees: 100, slippage: 0, positions: [{ code: 'A', sector: 'x', qty: 100, startPrice: 100, endPrice: 110 }] })
  assert.deepEqual(mismatch.reconciliation, { positionPnlSum: 1000, feeEffect: -100, slippageEffect: 0, residualPnl: -150, status: 'degraded' })
})

test('evaluateDecisionOutcome: 固定观察窗计算超额收益与MFE/MAE', () => {
  const o = evaluateDecisionOutcome({
    action: 'buy', decisionPrice: 10, benchmarkPrice: 100,
    observedPrice: 11, observedBenchmark: 105, high: 12, low: 9,
  })
  assert.equal(o.absoluteReturn, 0.1)
  assert.equal(o.excessReturn, 0.05)
  assert.equal(o.mfe, 0.2)
  assert.equal(o.mae, -0.1)
  assert.equal(o.hit, true)
})

test('evaluateMarketSession: 边界缺失、漂移和报价覆盖形成可复核结论', () => {
  const result = evaluateMarketSession({
    date: '2026-07-13', expected: ['09:15', '09:30', '11:30', '13:00', '14:57', '15:00'],
    observed: [
      { boundary: '09:15', driftSeconds: 2 }, { boundary: '09:30', driftSeconds: 3 },
      { boundary: '11:30', driftSeconds: 1 }, { boundary: '13:00', driftSeconds: 4 },
      { boundary: '14:57', driftSeconds: 2 },
    ], quoteCoverage: 0.99, overlapSuppressed: 0,
  })
  assert.equal(result.pass, false)
  assert.deepEqual(result.missingBoundaries, ['15:00'])
  assert.equal(result.maxDriftSeconds, 4)
})

test('ResearchIntelligenceStore: 原子持久化各类快照并对事件幂等去重', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shion-intel-'))
  try {
    const store = new ResearchIntelligenceStore(dir)
    const input = { source: 'cninfo', title: '600519 重大资产重组停牌公告', publishedAt: '2026-07-13T01:00:00Z' }
    store.ingestEvents([input, input], ['600519'])
    store.saveValuation({ code: '600519', asOf: '2026-07-13T01:00:00Z', value: 1 })
    store.saveAttribution({ asOf: '2026-07-13T07:00:00Z', netReturn: 0.01 })
    store.saveOutcome({ decisionId: 'd1', horizonDays: 20, decisionAt: '2026-06-01T00:00:00Z',
      dueAt: '2026-06-21T00:00:00Z', observedAt: '2026-06-21T08:00:00Z', excessReturn: 0.02 })
    store.saveSessionAudit({ date: '2026-07-13', pass: true })
    const restored = new ResearchIntelligenceStore(dir).snapshot()
    assert.equal(restored.events.length, 1)
    assert.equal(restored.valuations[0]!.code, '600519')
    assert.equal(restored.attributions.length, 1)
    assert.equal(restored.outcomes.length, 1)
    assert.equal(restored.sessionAudits.length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('ResearchIntelligenceStore rejects duplicate quote, valuation and attribution identities', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shion-intel-idempotent-'))
  try {
    const store = new ResearchIntelligenceStore(dir)
    const quote = { code: '600519', checkedAt: '2026-07-13T01:00:00Z' }
    const valuation = { code: '600519', asOf: '2026-07-13T01:00:00Z' }
    const attribution = { asOf: '2026-07-13T07:00:00Z' }
    store.saveQuoteCheck(quote); store.saveValuation(valuation); store.saveAttribution(attribution)
    assert.throws(() => store.saveQuoteCheck(quote), /already recorded/)
    assert.throws(() => store.saveValuation(valuation), /already recorded/)
    assert.throws(() => store.saveAttribution(attribution), /already recorded/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('ResearchIntelligenceStore: bounded public state prevents unbounded growth', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shion-intel-'))
  try {
    const store = new ResearchIntelligenceStore(dir)
    store.saveValuation({ code: '600519', asOf: '2026-07-13T01:00:00Z' })
    // bounded public API 不允许无限增长
    for (let i = 0; i < 250; i++) store.saveOutcome({ decisionId: `d${i}`, horizonDays: 20,
      decisionAt: '2026-06-01T00:00:00Z', dueAt: '2026-06-21T00:00:00Z', observedAt: '2026-06-21T08:00:00Z' })
    assert.equal(store.snapshot().outcomes.length, 200)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('ResearchIntelligenceStore rejects duplicate decision+horizon outcomes and early observation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shion-outcome-'))
  try {
    const store = new ResearchIntelligenceStore(dir)
    const value = { decisionId: 'd1', horizonDays: 20, decisionAt: '2026-06-01T00:00:00Z',
      dueAt: '2026-06-21T00:00:00Z', observedAt: '2026-06-21T08:00:00Z' }
    store.saveOutcome(value)
    assert.throws(() => store.saveOutcome(value), /already recorded/)
    assert.throws(() => store.saveOutcome({ ...value, decisionId: 'd2', observedAt: '2026-06-20T00:00:00Z' }), /observation window/)
    assert.throws(() => store.saveOutcome({ ...value, decisionId: 'd3', dueAt: '2026-06-02T00:00:00Z', observedAt: '2026-06-02T00:00:00Z' }), /observation window/)
    assert.throws(() => store.saveOutcome({ ...value, decisionId: 'd4', decisionAt: '2026-06-01T00:00:00' }), /observation window/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
