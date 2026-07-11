import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ToolContext } from '../../../core/types.js'
import {
  investmentCaseListTool,
  investmentCaseUpsertTool,
  investmentDecisionListTool,
  investmentDecisionRecordTool,
  investmentEvidenceAppendTool,
  portfolioRiskAnalyzeTool,
  aStockQuoteReconcileTool,
  aStockEventIngestTool,
  aStockValuationRecordTool,
  portfolioAttributionRecordTool,
  investmentOutcomeRecordTool,
  marketSessionAuditRecordTool,
  researchIntelligenceStatusTool,
} from './index.js'

function withDataDir(fn: (dataDir: string, ctx: ToolContext) => Promise<void>): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'mu-finance-tools-'))
  const ctx = { dataDir, log: () => {} } as unknown as ToolContext
  return fn(dataDir, ctx).finally(() => rmSync(dataDir, { recursive: true, force: true }))
}

test('finance research ToolDefs create/list cases, append evidence, and record/list decisions', () => withDataDir(async (_dataDir, ctx) => {
  const created = await investmentCaseUpsertTool.execute({
    code: '600519', name: '贵州茅台', horizon: 'long_term', thesis: '品牌力',
    catalysts: ['渠道改善'], risks: ['需求变化'], invalidation: ['批价持续下降'],
    confidence: 0.7, status: 'active', review_at: '2026-08-01T00:00:00.000Z',
  }, ctx)
  assert.equal(created.success, true)
  const caseId = (JSON.parse(created.output) as { id: string }).id

  const evidence = await investmentEvidenceAppendTool.execute({
    case_id: caseId, source: '年报', as_of: '2025-12-31T00:00:00.000Z', kind: 'fact', content: '经营现金流为正',
  }, ctx)
  assert.equal(evidence.success, true)
  const evidenceId = (JSON.parse(evidence.output) as { id: string }).id

  const decision = await investmentDecisionRecordTool.execute({
    action: 'watch', rationale: '等待估值', case_id: caseId,
    expected_outcome: '获得更好风险收益比', invalidation: '盈利下修', evidence_ids: [evidenceId],
  }, ctx)
  assert.equal(decision.success, true)
  assert.equal((JSON.parse((await investmentCaseListTool.execute({}, ctx)).output) as unknown[]).length, 1)
  assert.equal((JSON.parse((await investmentDecisionListTool.execute({}, ctx)).output) as unknown[]).length, 1)
}))

test('research intelligence ToolDefs persist quote/event/valuation/attribution/outcome/session evidence', () => withDataDir(async (_dataDir, ctx) => {
  const quote = await aStockQuoteReconcileTool.execute({
    code: '600519', now: '2026-07-13T02:00:10Z', observations: [
      { source: 'ifind', price: 10, asOf: '2026-07-13T02:00:09Z' },
      { source: 'tencent', price: 10.01, asOf: '2026-07-13T02:00:09Z' },
    ],
  }, ctx)
  assert.equal(quote.success, true)
  assert.equal((JSON.parse(quote.output) as { status: string }).status, 'consistent')

  assert.equal((await aStockEventIngestTool.execute({
    events: [{ source: 'cninfo', title: '600519 重大资产重组停牌公告', publishedAt: '2026-07-13T01:00:00Z' }],
    position_codes: ['600519'],
  }, ctx)).success, true)
  assert.equal((await aStockValuationRecordTool.execute({
    code: '600519', as_of: '2026-07-13T01:00:00Z', price: 1200, forward_eps: 70,
    next_forward_eps: 80, target_pe: { bear: 15, base: 20, bull: 25 }, analyst_count: 18,
    evidence: { price: { source: 'tencent', asOf: '2026-07-13T01:00:00Z' },
      forwardEps: { source: 'ifind', asOf: '2026-07-12T00:00:00Z' }, nextForwardEps: { source: 'ifind', asOf: '2026-07-12T00:00:00Z' } },
  }, ctx)).success, true)
  assert.equal((await portfolioAttributionRecordTool.execute({
    as_of: '2026-07-13T07:00:00Z', start_equity: 100000, actual_end_equity: 100900, net_cash_flow: 0,
    benchmark_return: 0.01, fees: 100, slippage: 0,
    positions: [{ code: '600519', sector: '白酒', qty: 10, startPrice: 1000, endPrice: 1100 }],
  }, ctx)).success, true)
  assert.equal((await investmentOutcomeRecordTool.execute({
    decision_id: 'd1', horizon_days: 20, decision_at: '2026-06-01T00:00:00Z', due_at: '2026-06-21T00:00:00Z', observed_at: '2026-06-21T08:00:00Z',
    action: 'buy', decision_price: 10, benchmark_price: 100,
    observed_price: 11, observed_benchmark: 105, high: 12, low: 9,
  }, ctx)).success, true)
  assert.equal((await marketSessionAuditRecordTool.execute({
    date: '2026-07-13', expected: ['09:15'], observed: [{ boundary: '09:15', driftSeconds: 2 }],
    quote_coverage: 1, overlap_suppressed: 0,
  }, ctx)).success, true)
  const status = JSON.parse((await researchIntelligenceStatusTool.execute({}, ctx)).output) as {
    quoteChecks: unknown[]; events: unknown[]; valuations: unknown[]; attributions: unknown[]; outcomes: unknown[]; sessionAudits: unknown[]
  }
  assert.equal(status.quoteChecks.length, 1)
  assert.equal(status.events.length, 1)
  assert.equal(status.valuations.length, 1)
  assert.equal(status.attributions.length, 1)
  assert.equal(status.outcomes.length, 1)
  assert.equal(status.sessionAudits.length, 1)
}))

test('portfolio_risk_analyze falls back to a fresh watchdog snapshot and atomically writes latest risk', () => withDataDir(async (dataDir, ctx) => {
  writeFileSync(join(dataDir, 'portfolio.json'), 'unrelated', 'utf8')
  const memoryDir = join(dataDir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  writeFileSync(join(memoryDir, 'portfolio.json'), JSON.stringify([
    { id: 'p1', code: 'AAA', name: '甲', qty: 10, cost: 8, stop_loss: 9, status: 'active', updated: '2026-07-10T00:00:00.000Z' },
  ]), 'utf8')
  writeFileSync(join(memoryDir, 'watchdog-health.json'), JSON.stringify({
    status: 'healthy', as_of: '2026-07-10T01:00:00.000Z', prices: { AAA: 11 },
  }), 'utf8')

  assert.deepEqual(portfolioRiskAnalyzeTool.requiredKeys, [])
  const fallback = await portfolioRiskAnalyzeTool.execute({
    now: '2026-07-10T01:05:00.000Z', sectors: { AAA: '消费' },
  }, ctx)
  assert.equal(fallback.success, true)
  assert.equal((JSON.parse(fallback.output) as { total_market_value: number }).total_market_value, 110)

  const result = await portfolioRiskAnalyzeTool.execute({
    as_of: '2026-07-10T01:00:00.000Z', now: '2026-07-10T01:05:00.000Z', prices: { AAA: 12 }, sectors: { AAA: '消费' },
  }, ctx)
  assert.equal(result.success, true)
  const latest = join(memoryDir, 'portfolio-risk-latest.json')
  assert.equal(existsSync(latest), true)
  assert.equal((JSON.parse(readFileSync(latest, 'utf8')) as { total_market_value: number }).total_market_value, 120)
}))

test('portfolio_risk_analyze rejects missing, stale, and invalid watchdog snapshots without fetching', () => withDataDir(async (dataDir, ctx) => {
  const memoryDir = join(dataDir, 'memory')
  mkdirSync(memoryDir, { recursive: true })

  const missing = await portfolioRiskAnalyzeTool.execute({ now: '2026-07-10T01:05:00.000Z' }, ctx)
  assert.equal(missing.success, false)
  assert.match(missing.error ?? '', /watchdog.*missing/i)

  writeFileSync(join(memoryDir, 'watchdog-health.json'), JSON.stringify({
    status: 'healthy', as_of: '2026-07-10T00:00:00.000Z', prices: { AAA: 12 },
  }), 'utf8')
  const stale = await portfolioRiskAnalyzeTool.execute({ now: '2026-07-10T01:05:00.000Z' }, ctx)
  assert.equal(stale.success, false)
  assert.match(stale.error ?? '', /stale/i)

  writeFileSync(join(memoryDir, 'watchdog-health.json'), JSON.stringify({
    status: 'healthy', as_of: '2026-07-10T01:00:00.000Z', prices: { AAA: -1 },
  }), 'utf8')
  const invalid = await portfolioRiskAnalyzeTool.execute({ now: '2026-07-10T01:05:00.000Z' }, ctx)
  assert.equal(invalid.success, false)
  assert.match(invalid.error ?? '', /price/i)
  assert.equal(existsSync(join(memoryDir, 'portfolio-risk-latest.json')), false)
}))

test('portfolio_risk_analyze 缺任一 active 持仓价格时 fail closed 且不写 latest', () => withDataDir(async (dataDir, ctx) => {
  const memoryDir = join(dataDir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  writeFileSync(join(memoryDir, 'portfolio.json'), JSON.stringify([
    { id: 'p1', code: 'AAA', name: '甲', qty: 10, cost: 8, stop_loss: 9, status: 'active', updated: '2026-07-10T00:00:00.000Z' },
    { id: 'p2', code: 'BBB', name: '乙', qty: 20, cost: 2, stop_loss: 1.5, status: 'active', updated: '2026-07-10T00:00:00.000Z' },
  ]))

  const result = await portfolioRiskAnalyzeTool.execute({
    as_of: '2026-07-10T01:00:00.000Z',
    now: '2026-07-10T01:05:00.000Z',
    prices: { AAA: 12 },
  }, ctx)

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /missing.*BBB|BBB.*missing/i)
  assert.equal(existsSync(join(memoryDir, 'portfolio-risk-latest.json')), false)
}))

test('portfolio_risk_analyze 拒绝超出 clock-skew tolerance 的未来快照且不写 latest', () => withDataDir(async (dataDir, ctx) => {
  const memoryDir = join(dataDir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  writeFileSync(join(memoryDir, 'portfolio.json'), JSON.stringify([
    { id: 'p1', code: 'AAA', name: '甲', qty: 10, cost: 8, stop_loss: 9, status: 'active', updated: '2026-07-10T00:00:00.000Z' },
  ]))

  const result = await portfolioRiskAnalyzeTool.execute({
    as_of: '2026-07-10T01:02:00.000Z',
    now: '2026-07-10T01:00:00.000Z',
    prices: { AAA: 12 },
  }, ctx)

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /future|clock skew/i)
  assert.equal(existsSync(join(memoryDir, 'portfolio-risk-latest.json')), false)
}))

test('finance ToolDefs fail safely on corrupt research or portfolio state', () => withDataDir(async (dataDir, ctx) => {
  const memoryDir = join(dataDir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  writeFileSync(join(memoryDir, 'investment-cases.json'), '{broken', 'utf8')
  writeFileSync(join(memoryDir, 'portfolio.json'), '{broken', 'utf8')
  const cases = await investmentCaseListTool.execute({}, ctx)
  const risk = await portfolioRiskAnalyzeTool.execute({
    as_of: '2026-07-10T01:00:00.000Z', prices: { AAA: 12 },
  }, ctx)
  assert.equal(cases.success, false)
  assert.equal(risk.success, false)
}))
