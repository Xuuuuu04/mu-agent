import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { AdminApi } from './admin-api.js'
import { Outbox } from './outbox.js'

async function requestFinance(dataDir: string): Promise<{ handled: boolean; status: number; body: unknown }> {
  let status = 0
  let raw = ''
  const res = {
    writeHead(code: number) { status = code; return this },
    end(chunk?: string) { raw = chunk ?? ''; return this },
  } as unknown as ServerResponse
  const api = new AdminApi({
    store: null,
    opts: { dataDir },
    outbox: new Outbox(null),
    getEventHandler: () => null,
  })
  const handled = await api.tryHandle(
    '/api/finance', 'GET', {} as IncomingMessage, res, new URLSearchParams(),
  )
  return { handled, status, body: raw ? JSON.parse(raw) : null }
}

test('/api/finance: missing files return a stable empty contract', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shion-finance-api-'))
  mkdirSync(join(dir, 'memory'), { recursive: true })
  try {
    const r = await requestFinance(dir)
    assert.equal(r.handled, true)
    assert.equal(r.status, 200)
    assert.deepEqual(r.body, {
      positions: [], investment_cases: [], decisions: [], alerts: [],
      watchdog: null, portfolio_risk: null, backtest: null, simulation_analysis: null,
      research_intelligence: { status: 'empty', error: null, quote_checks: [], events: [], valuations: [], attributions: [], outcomes: [], session_audits: [] },
      daily_research: { status: 'empty', error: null, cycles: [], last_attempt_at: null, last_success_at: null,
        last_finalized_date: null, next_run_at: null, expected_codes: [], covered_codes: [], missing_codes: [], coverage: null,
        active_expected_codes: [], active_covered_codes: [], active_missing_codes: [], active_coverage: null,
        pending_decision_count: 0, due_decision_count: 0, oldest_due_at: null, outcome_count: 0,
        outcome_window_count: 0, outcome_hit_rate: null, average_excess_return: null, degraded_reasons: [] },
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('/api/finance: aggregates active records and bounds journal/alerts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shion-finance-api-'))
  const mem = join(dir, 'memory')
  mkdirSync(mem, { recursive: true })
  mkdirSync(join(dir, 'backtest'), { recursive: true })
  try {
    writeFileSync(join(mem, 'portfolio.json'), JSON.stringify([
      { id: 'p1', status: 'active' }, { id: 'p2', status: 'closed' },
    ]))
    writeFileSync(join(mem, 'investment-cases.json'), JSON.stringify({ version: 1, cases: [
      { id: 'c1', status: 'active' }, { id: 'c2', status: 'closed' },
    ] }))
    writeFileSync(join(mem, 'decision-journal.json'), JSON.stringify({ version: 1, entries:
      Array.from({ length: 60 }, (_, i) => ({ id: `d${i}` })),
    }))
    writeFileSync(join(mem, 'watchdog-health.json'), JSON.stringify({ status: 'healthy', next_tick_at: '2026-07-15T07:00:00Z' }))
    writeFileSync(join(mem, 'portfolio-risk-latest.json'), JSON.stringify({ total_market_value: 1000 }))
    writeFileSync(join(mem, 'research-intelligence.json'), JSON.stringify({ version: 1,
      quoteChecks: Array.from({ length: 25 }, (_, i) => ({ i })), events: [{ id: 'e1' }],
      valuations: [{ code: '600519' }], attributions: [],
      outcomes: [{ decisionId: 'recent-1', hit: true, excessReturn: 0.02 }],
      completedOutcomeKeys: Array.from({ length: 300 }, (_, i) => `d${i}|20`),
      outcomeStats: { totalCount: 300, hitCount: 180, excessReturnSum: 9 }, sessionAudits: [{ pass: true }],
    }))
    writeFileSync(join(mem, 'daily-research.json'), JSON.stringify({ version: 1, cycles: [
      { date: '2026-07-15', code: '600519', status: 'collecting', missingEvidence: ['forward consensus EPS is unavailable'] },
    ], coverageByDate: [{ date: '2026-07-15', expectedCodes: ['600519', '688012'], coveredCodes: ['600519'],
      missingCodes: ['688012'], latestCoverage: 0.5, minCoverage: 0.5, asOf: '2026-07-15T06:00:00Z' }],
    decisionTrackers: [{ decisionId: 'pending-1', dueAt: '2026-07-15T05:00:00Z' }],
    lastAttemptAt: '2026-07-15T06:00:00Z', lastSuccessAt: null, lastError: 'missing verified quotes: 688012', lastFinalizedDate: null }))
    writeFileSync(join(mem, 'alerts.log'), Array.from({ length: 30 }, (_, i) => `alert-${i}`).join('\n') + '\n')
    writeFileSync(join(dir, 'backtest', 'latest-report.json'), JSON.stringify({ strategy: 'ma_cross' }))
    writeFileSync(join(dir, 'backtest', 'latest-simulation-analysis.json'), JSON.stringify({ account: 'paper' }))

    const r = await requestFinance(dir)
    const x = r.body as Record<string, unknown>
    assert.deepEqual((x.positions as Array<{ id: string }>).map(p => p.id), ['p1'])
    assert.deepEqual((x.investment_cases as Array<{ id: string }>).map(c => c.id), ['c1'])
    assert.equal((x.decisions as unknown[]).length, 50)
    assert.equal((x.decisions as Array<{ id: string }>)[0]!.id, 'd10')
    assert.equal((x.alerts as string[]).length, 20)
    assert.equal((x.alerts as string[])[0], 'alert-10')
    assert.equal((x.watchdog as { status: string }).status, 'healthy')
    assert.equal((x.backtest as { strategy: string }).strategy, 'ma_cross')
    const intel = x.research_intelligence as { quote_checks: Array<{ i: number }>; events: unknown[] }
    assert.equal(intel.quote_checks.length, 20)
    assert.equal(intel.quote_checks[0]!.i, 5)
    assert.deepEqual(intel.events, [{ id: 'e1' }])
    assert.equal((x.research_intelligence as { status: string }).status, 'healthy')
    assert.equal((x.daily_research as { status: string }).status, 'degraded')
    assert.equal((x.daily_research as { cycles: unknown[] }).cycles.length, 1)
    assert.equal((x.daily_research as { coverage: number }).coverage, 0.5)
    assert.deepEqual((x.daily_research as { missing_codes: string[] }).missing_codes, ['688012'])
    assert.equal((x.daily_research as { pending_decision_count: number }).pending_decision_count, 1)
    assert.equal((x.daily_research as { next_run_at: string }).next_run_at, '2026-07-15T07:00:00Z')
    assert.equal((x.daily_research as { outcome_count: number }).outcome_count, 300)
    assert.equal((x.daily_research as { outcome_window_count: number }).outcome_window_count, 1)
    assert.equal((x.daily_research as { outcome_hit_rate: number }).outcome_hit_rate, 0.6)
    assert.equal((x.daily_research as { average_excess_return: number }).average_excess_return, 0.03)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('/api/finance: corrupt research intelligence is explicit degraded, not fake empty', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shion-finance-corrupt-intel-'))
  mkdirSync(join(dir, 'memory'), { recursive: true })
  try {
    writeFileSync(join(dir, 'memory', 'research-intelligence.json'), '{broken')
    const r = await requestFinance(dir)
    const intel = (r.body as { research_intelligence: { status: string; error: string } }).research_intelligence
    assert.equal(intel.status, 'degraded')
    assert.match(intel.error, /unreadable/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('/api/finance: parseable intelligence with invalid array fields is degraded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shion-finance-schema-intel-'))
  mkdirSync(join(dir, 'memory'), { recursive: true })
  try {
    writeFileSync(join(dir, 'memory', 'research-intelligence.json'), JSON.stringify({ version: 1,
      quoteChecks: 'bad', events: [], valuations: [], attributions: [], outcomes: [], sessionAudits: [] }))
    const r = await requestFinance(dir)
    assert.equal(((r.body as Record<string, unknown>).research_intelligence as { status: string }).status, 'degraded')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('/api/finance: invalid daily research cycles cannot masquerade as healthy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shion-finance-schema-daily-'))
  mkdirSync(join(dir, 'memory'), { recursive: true })
  try {
    writeFileSync(join(dir, 'memory', 'daily-research.json'), JSON.stringify({ version: 1,
      cycles: [{ date: 20260715, code: '600519', status: 'done', missingEvidence: 'none' }],
      lastSuccessAt: null, lastError: null, lastFinalizedDate: null }))
    const r = await requestFinance(dir)
    const daily = (r.body as { daily_research: { status: string; error: string } }).daily_research
    assert.equal(daily.status, 'degraded')
    assert.match(daily.error, /schema/i)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('/api/finance: parseable invalid case, decisions and risk degrade independently', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shion-finance-invalid-api-'))
  const mem = join(dir, 'memory')
  mkdirSync(mem, { recursive: true })
  try {
    writeFileSync(join(mem, 'investment-cases.json'), JSON.stringify({ version: 1, cases: [
      { id: 'c1', status: 'active', code: '600519', name: '贵州茅台', thesis: 't', confidence: 0.8,
        catalysts: 'not-array', risks: ['valid', 3], review_at: '2026-12-31T00:00:00Z' },
      { id: 'c2', status: 'active', code: 123, name: null },
    ] }))
    writeFileSync(join(mem, 'decision-journal.json'), JSON.stringify({ version: 1, entries: [
      { action: 'hold', rationale: 'valid', timestamp: '2026-01-01T00:00:00Z' },
      'bad', { action: [], rationale: 3 },
      { id: 'd2', action: 'buy', rationale: 'bad baseline', timestamp: '2026-01-01T00:00:00Z',
        code: '600519', decision_price: 'not-a-number' },
    ] }))
    writeFileSync(join(mem, 'portfolio-risk-latest.json'), JSON.stringify(['bad-shape']))
    const r = await requestFinance(dir)
    assert.equal(r.status, 200)
    const x = r.body as Record<string, unknown>
    assert.deepEqual(x.investment_cases, [{
      id: 'c1', status: 'active', code: '600519', name: '贵州茅台', thesis: 't', confidence: 0.8,
      catalysts: [], risks: ['valid'], review_at: '2026-12-31T00:00:00Z',
    }])
    assert.deepEqual(x.decisions, [
      { action: 'hold', rationale: 'valid', timestamp: '2026-01-01T00:00:00Z' },
    ])
    assert.equal(x.portfolio_risk, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
