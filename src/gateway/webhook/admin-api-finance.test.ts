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
    writeFileSync(join(mem, 'watchdog-health.json'), JSON.stringify({ status: 'healthy' }))
    writeFileSync(join(mem, 'portfolio-risk-latest.json'), JSON.stringify({ total_market_value: 1000 }))
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
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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
