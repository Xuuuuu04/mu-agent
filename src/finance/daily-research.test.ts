import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchIntelligenceStore } from './research-intelligence.js'
import { DecisionJournalStore } from './research-store.js'
import type { Position } from '../core/types.js'

const modulePath = './daily-research.js'

test('DailyResearchOrchestrator turns verified ticks into valuation and daily attribution', async () => {
  const module = await import(modulePath).catch(() => null) as null | Record<string, any>
  assert.ok(module?.DailyResearchOrchestrator, 'daily research orchestrator must exist')
  const dir = mkdtempSync(join(tmpdir(), 'shion-daily-research-'))
  try {
    const intelligence = new ResearchIntelligenceStore(dir)
    const orchestrator = new module.DailyResearchOrchestrator({ dataDir: dir, intelligence })
    const position: Position = { id: 'p1', code: '688012', name: '中微公司', qty: 10, cost: 406.3,
      stop_loss: 450, status: 'active', updated: '2026-07-10T00:00:00Z' }
    orchestrator.recordTick({ now: new Date('2026-07-15T01:30:00Z'), positions: [position], quotes: new Map([
      ['688012', { name: '中微公司', price: 405, asOf: '2026-07-15T01:30:00Z', peTtm: 70, pb: 13, sources: ['primary', 'tencent'] }],
    ]), benchmark: { price: 4500, asOf: '2026-07-15T01:30:00Z', sources: ['tencent'] } })
    orchestrator.recordTick({ now: new Date('2026-07-15T06:59:30Z'), positions: [position], quotes: new Map([
      ['688012', { name: '中微公司', price: 391, asOf: '2026-07-15T06:59:30Z', peTtm: 68, pb: 12.4, sources: ['primary', 'tencent'] }],
    ]), benchmark: { price: 4455, asOf: '2026-07-15T06:59:30Z', sources: ['tencent'] } })
    orchestrator.finalize(new Date('2026-07-15T07:00:00Z'))

    const research = intelligence.snapshot()
    assert.equal(research.valuations.length, 1)
    assert.equal(research.valuations[0]!.coverage, 'medium')
    assert.equal(research.attributions.length, 1)
    assert.equal(research.attributions[0]!.scope, 'active_positions_only')
    const state = orchestrator.getHealthSnapshot()
    assert.equal(state.status, 'degraded')
    assert.equal(state.last_finalized_date, '2026-07-15')
    assert.match(state.degraded_reasons.join(' '), /forward consensus|account cash/i)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('DailyResearchOrchestrator is idempotent across duplicate ticks and restart', async () => {
  const module = await import(modulePath).catch(() => null) as null | Record<string, any>
  assert.ok(module?.DailyResearchOrchestrator, 'daily research orchestrator must exist')
  const dir = mkdtempSync(join(tmpdir(), 'shion-daily-restart-'))
  try {
    const intelligence = new ResearchIntelligenceStore(dir)
    const input = { now: new Date('2026-07-15T01:30:00Z'), positions: [{ id: 'p1', code: '688012', name: '中微公司', qty: 1,
      cost: 400, status: 'active', updated: '2026-07-10T00:00:00Z' }], quotes: new Map([
        ['688012', { price: 405, asOf: '2026-07-15T01:30:00Z', peTtm: 70, pb: 13, sources: ['primary', 'tencent'] }],
      ]), benchmark: { price: 4500, asOf: '2026-07-15T01:30:00Z', sources: ['tencent'] } }
    new module.DailyResearchOrchestrator({ dataDir: dir, intelligence }).recordTick(input)
    new module.DailyResearchOrchestrator({ dataDir: dir, intelligence }).recordTick(input)
    assert.equal(intelligence.snapshot().valuations.length, 1)
    const cycle = new module.DailyResearchOrchestrator({ dataDir: dir, intelligence }).snapshot().cycles[0]!
    assert.equal(cycle.sampleCount, 1, 'same source timestamp must not inflate the path sample count')
    assert.equal(cycle.observations.length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('DailyResearchOrchestrator ignores call-auction ticks as daily attribution baseline', async () => {
  const module = await import(modulePath) as Record<string, any>
  const dir = mkdtempSync(join(tmpdir(), 'shion-daily-auction-'))
  try {
    const intelligence = new ResearchIntelligenceStore(dir)
    const orchestrator = new module.DailyResearchOrchestrator({ dataDir: dir, intelligence })
    const position = { id: 'p1', code: '688012', name: '中微公司', qty: 1, cost: 400,
      status: 'active', updated: '2026-07-10T00:00:00Z' }
    orchestrator.recordTick({ now: new Date('2026-07-15T01:20:00Z'), positions: [position], quotes: new Map([
      ['688012', { price: 410, asOf: '2026-07-15T01:20:00Z' }],
    ]) })
    orchestrator.recordTick({ now: new Date('2026-07-15T01:30:00Z'), positions: [position], quotes: new Map([
      ['688012', { price: 405, asOf: '2026-07-15T01:30:00Z' }],
    ]) })
    assert.equal(orchestrator.snapshot().cycles[0]!.firstPrice, 405)
    assert.equal(intelligence.snapshot().valuations.length, 0, 'price-only evidence is not a valuation')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('DailyResearchOrchestrator rejects stale price evidence instead of recording it', async () => {
  const module = await import(modulePath) as Record<string, any>
  const dir = mkdtempSync(join(tmpdir(), 'shion-daily-stale-'))
  try {
    const intelligence = new ResearchIntelligenceStore(dir)
    const orchestrator = new module.DailyResearchOrchestrator({ dataDir: dir, intelligence })
    const position = { id: 'p1', code: '688012', name: '中微公司', qty: 1, cost: 400,
      status: 'active', updated: '2026-07-10T00:00:00Z' }
    orchestrator.recordTick({ now: new Date('2026-07-15T02:00:00Z'), positions: [position], quotes: new Map([
      ['688012', { price: 405, asOf: '2026-07-15T01:30:00Z', peTtm: 70, sources: ['tencent'] }],
    ]) })
    assert.equal(orchestrator.snapshot().cycles.length, 0)
    assert.equal(intelligence.snapshot().valuations.length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('DailyResearchOrchestrator never reports fake zero benchmark return when benchmark is missing', async () => {
  const module = await import(modulePath) as Record<string, any>
  const dir = mkdtempSync(join(tmpdir(), 'shion-daily-no-benchmark-'))
  try {
    const intelligence = new ResearchIntelligenceStore(dir)
    const orchestrator = new module.DailyResearchOrchestrator({ dataDir: dir, intelligence })
    const position = { id: 'p1', code: '688012', name: '中微公司', qty: 1, cost: 400,
      status: 'active', updated: '2026-07-10T00:00:00Z' }
    orchestrator.recordTick({ now: new Date('2026-07-15T01:30:00Z'), positions: [position], quotes: new Map([
      ['688012', { price: 405, asOf: '2026-07-15T01:30:00Z', peTtm: 70 }],
    ]) })
    orchestrator.finalize(new Date('2026-07-15T07:00:00Z'))
    const attribution = intelligence.snapshot().attributions[0]!
    assert.equal(attribution.benchmarkReturn, null)
    assert.equal(attribution.excessReturn, null)
    assert.match(String(attribution.degradedReasons), /benchmark/i)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('DailyResearchOrchestrator recovers an unfinalized prior trading day after restart', async () => {
  const module = await import(modulePath) as Record<string, any>
  const dir = mkdtempSync(join(tmpdir(), 'shion-daily-recovery-'))
  try {
    const intelligence = new ResearchIntelligenceStore(dir)
    const position = { id: 'p1', code: '688012', name: '中微公司', qty: 1, cost: 400,
      status: 'active', updated: '2026-07-10T00:00:00Z' }
    new module.DailyResearchOrchestrator({ dataDir: dir, intelligence }).recordTick({
      now: new Date('2026-07-15T06:59:30Z'), positions: [position], quotes: new Map([
        ['688012', { price: 390, asOf: '2026-07-15T06:59:30Z', peTtm: 67 }],
      ]), benchmark: { price: 4450, asOf: '2026-07-15T06:59:30Z' },
    })
    const restarted = new module.DailyResearchOrchestrator({ dataDir: dir, intelligence })
    restarted.recordTick({ now: new Date('2026-07-16T01:30:00Z'), positions: [position], quotes: new Map([
      ['688012', { price: 392, asOf: '2026-07-16T01:30:00Z', peTtm: 68 }],
    ]), benchmark: { price: 4460, asOf: '2026-07-16T01:30:00Z' } })
    const state = restarted.snapshot()
    assert.equal(state.cycles.find((item: any) => item.date === '2026-07-15')?.status, 'finalized')
    assert.equal(state.cycles.find((item: any) => item.date === '2026-07-16')?.status, 'collecting')
    assert.equal(intelligence.snapshot().attributions.some(item => item.date === '2026-07-15'), true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('DailyResearchOrchestrator evaluates due actionable decisions without hindsight sampling', async () => {
  const module = await import(modulePath) as Record<string, any>
  const dir = mkdtempSync(join(tmpdir(), 'shion-daily-outcome-'))
  try {
    const intelligence = new ResearchIntelligenceStore(dir)
    new DecisionJournalStore(dir, { now: () => '2026-07-14T01:30:00.000Z', id: () => 'decision-1' }).record({
      action: 'buy', rationale: '估值进入区间', position_id: 'p1', expected_outcome: '跑赢沪深300', invalidation: '基本面下修',
      evidence_ids: [], code: '688012', decision_price: 400, benchmark_code: '000300', benchmark_price: 4500, horizon_days: 1,
      decision_price_source: 'ifind+tencent quorum', decision_price_as_of: '2026-07-14T01:29:59.000Z',
      benchmark_source: 'tencent', benchmark_as_of: '2026-07-14T01:29:59.000Z',
    } as any)
    const orchestrator = new module.DailyResearchOrchestrator({ dataDir: dir, intelligence })
    const position = { id: 'p1', code: '688012', name: '中微公司', qty: 1, cost: 400,
      status: 'active', updated: '2026-07-10T00:00:00Z' }
    orchestrator.recordTick({ now: new Date('2026-07-15T01:30:00Z'), positions: [position], quotes: new Map([
      ['688012', { price: 395, asOf: '2026-07-15T01:30:00Z', peTtm: 68, pb: 12 }],
    ]), benchmark: { price: 4470, asOf: '2026-07-15T01:30:00Z' } })
    orchestrator.recordTick({ now: new Date('2026-07-15T06:59:30Z'), positions: [position], quotes: new Map([
      ['688012', { price: 390, asOf: '2026-07-15T06:59:30Z', peTtm: 67, pb: 11.8 }],
    ]), benchmark: { price: 4450, asOf: '2026-07-15T06:59:30Z' } })
    orchestrator.finalize(new Date('2026-07-15T07:00:00Z'))
    const outcome = intelligence.snapshot().outcomes[0]!
    assert.equal(outcome.decisionId, 'decision-1')
    assert.equal(outcome.horizonDays, 1)
    assert.equal(outcome.observedPrice, 395)
    assert.equal(outcome.observedBenchmark, 4470)
    assert.equal(outcome.mfe, 0)
    assert.equal(outcome.mae, -0.0125)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('DailyResearchOrchestrator excludes pre-decision prices from MFE and MAE', async () => {
  const module = await import(modulePath) as Record<string, any>
  const dir = mkdtempSync(join(tmpdir(), 'shion-daily-no-hindsight-'))
  try {
    const intelligence = new ResearchIntelligenceStore(dir)
    const orchestrator = new module.DailyResearchOrchestrator({ dataDir: dir, intelligence })
    const position = { id: 'p1', code: '688012', name: '中微公司', qty: 1, cost: 400,
      status: 'active', updated: '2026-07-10T00:00:00Z' }
    orchestrator.recordTick({ now: new Date('2026-07-14T01:30:00Z'), positions: [position], quotes: new Map([
      ['688012', { price: 500, asOf: '2026-07-14T01:30:00Z', sources: ['primary', 'tencent'] }],
    ]), benchmark: { price: 4500, asOf: '2026-07-14T01:30:00Z', sources: ['tencent'] } })
    new DecisionJournalStore(dir, { now: () => '2026-07-14T03:00:00.000Z', id: () => 'decision-path' }).record({
      action: 'buy', rationale: '估值进入区间', position_id: 'p1', expected_outcome: '跑赢沪深300', invalidation: '基本面下修',
      evidence_ids: [], code: '688012', decision_price: 400, benchmark_code: '000300', benchmark_price: 4500, horizon_days: 1,
      decision_price_source: 'ifind+tencent quorum', decision_price_as_of: '2026-07-14T02:59:59.000Z',
      benchmark_source: 'tencent', benchmark_as_of: '2026-07-14T02:59:59.000Z',
    } as any)
    orchestrator.recordTick({ now: new Date('2026-07-14T06:00:00Z'), positions: [position], quotes: new Map([
      ['688012', { price: 410, asOf: '2026-07-14T06:00:00Z', sources: ['primary', 'tencent'] }],
    ]), benchmark: { price: 4510, asOf: '2026-07-14T06:00:00Z', sources: ['tencent'] } })
    orchestrator.recordTick({ now: new Date('2026-07-15T06:59:30Z'), positions: [position], quotes: new Map([
      ['688012', { price: 390, asOf: '2026-07-15T06:59:30Z', sources: ['primary', 'tencent'] }],
    ]), benchmark: { price: 4450, asOf: '2026-07-15T06:59:30Z', sources: ['tencent'] } })
    orchestrator.finalize(new Date('2026-07-15T07:00:00Z'))
    const outcome = intelligence.snapshot().outcomes[0]!
    assert.equal(outcome.mfe, 0.025, 'the 500 pre-decision quote must not enter MFE')
    assert.equal(outcome.mae, -0.025)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('DailyResearchOrchestrator waits for a verified quote at or after due time', async () => {
  const module = await import(modulePath) as Record<string, any>
  const dir = mkdtempSync(join(tmpdir(), 'shion-daily-due-boundary-'))
  try {
    const intelligence = new ResearchIntelligenceStore(dir)
    new DecisionJournalStore(dir, { now: () => '2026-07-14T03:00:00.000Z', id: () => 'decision-due' }).record({
      action: 'sell', rationale: '风险收益比恶化', position_id: 'p1', expected_outcome: '相对基准回避损失', invalidation: '盈利超预期',
      evidence_ids: [], code: '688012', decision_price: 400, benchmark_code: '000300', benchmark_price: 4500, horizon_days: 1,
      decision_price_source: 'quorum', decision_price_as_of: '2026-07-14T02:59:59.000Z',
      benchmark_source: 'tencent', benchmark_as_of: '2026-07-14T02:59:59.000Z',
    } as any)
    const orchestrator = new module.DailyResearchOrchestrator({ dataDir: dir, intelligence })
    orchestrator.recordTick({ now: new Date('2026-07-15T02:59:00Z'), positions: [], quotes: new Map([
      ['688012', { price: 390, asOf: '2026-07-15T02:59:00Z', sources: ['primary', 'tencent'] }],
    ]), benchmark: { price: 4450, asOf: '2026-07-15T02:59:00Z', sources: ['tencent'] } })
    orchestrator.finalize(new Date('2026-07-15T03:00:00Z'))
    assert.equal(intelligence.snapshot().outcomes.length, 0, 'pre-due quote cannot be published as the due outcome')
    orchestrator.recordTick({ now: new Date('2026-07-15T03:00:30Z'), positions: [], quotes: new Map([
      ['688012', { price: 388, asOf: '2026-07-15T03:00:30Z', sources: ['primary', 'tencent'] }],
    ]), benchmark: { price: 4440, asOf: '2026-07-15T03:00:30Z', sources: ['tencent'] } })
    const outcome = intelligence.snapshot().outcomes[0]!
    assert.equal(outcome.observedPrice, 388)
    assert.equal(outcome.observedQuoteAsOf, '2026-07-15T03:00:30Z')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('DailyResearchOrchestrator exposes missing active-position coverage and risk/event context', async () => {
  const module = await import(modulePath) as Record<string, any>
  const dir = mkdtempSync(join(tmpdir(), 'shion-daily-coverage-'))
  try {
    const intelligence = new ResearchIntelligenceStore(dir)
    intelligence.ingestEvents([{ source: 'cninfo', title: '688012 股东减持', publishedAt: '2026-07-15T01:00:00Z', codeHints: ['688012'] }], ['688012'])
    const orchestrator = new module.DailyResearchOrchestrator({ dataDir: dir, intelligence })
    const positions = [
      { id: 'p1', code: '688012', name: '中微公司', qty: 1, cost: 400, stop_loss: 380, take_profit: 500, status: 'active', updated: '2026-07-10T00:00:00Z' },
      { id: 'p2', code: '600519', name: '贵州茅台', qty: 1, cost: 1500, status: 'active', updated: '2026-07-10T00:00:00Z' },
    ]
    orchestrator.recordTick({ now: new Date('2026-07-15T01:30:00Z'), positions, quotes: new Map([
      ['688012', { price: 405, asOf: '2026-07-15T01:30:00Z', sources: ['primary', 'tencent'] }],
    ]) })
    const health = orchestrator.getHealthSnapshot()
    assert.equal(health.coverage, 0.5)
    assert.deepEqual(health.missing_codes, ['600519'])
    assert.equal(health.last_success_at, null, 'partial coverage is not a successful complete cycle')
    const cycle = orchestrator.snapshot().cycles[0]!
    assert.equal(cycle.risk.stopLoss, 380)
    assert.equal(cycle.risk.takeProfit, 500)
    assert.equal(cycle.eventIds.length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('DailyResearchOrchestrator keeps bounded per-decision extrema after raw cycles are evicted', async () => {
  const module = await import(modulePath) as Record<string, any>
  const dir = mkdtempSync(join(tmpdir(), 'shion-daily-tracker-retention-'))
  try {
    const intelligence = new ResearchIntelligenceStore(dir)
    new DecisionJournalStore(dir, { now: () => '2026-07-14T01:30:00.000Z', id: () => 'decision-retained' }).record({
      action: 'buy', rationale: '低估', position_id: 'p1', expected_outcome: '跑赢基准', invalidation: '基本面恶化', evidence_ids: [],
      code: '000001', decision_price: 100, benchmark_code: '000300', benchmark_price: 4500, horizon_days: 5,
      decision_price_source: 'quorum', decision_price_as_of: '2026-07-14T01:29:59.000Z', benchmark_source: 'tencent', benchmark_as_of: '2026-07-14T01:29:59.000Z',
    } as any)
    const orchestrator = new module.DailyResearchOrchestrator({ dataDir: dir, intelligence })
    const positions = Array.from({ length: 401 }, (_, i) => ({ id: `p${i}`, code: String(i + 1).padStart(6, '0'), name: `S${i}`,
      qty: 1, cost: 100, status: 'active', updated: '2026-07-10T00:00:00Z' }))
    for (const day of [14, 15, 16, 17, 18]) {
      const asOf = `2026-07-${day}T06:59:00Z`
      const quotes = new Map(positions.map((p, i) => [p.code, { price: day === 14 && i === 0 ? 150 : 100,
        asOf, sources: ['primary', 'tencent'] }]))
      orchestrator.recordTick({ now: new Date(asOf), positions, quotes,
        benchmark: { price: 4500 + day, asOf, sources: ['tencent'] } })
      if (day === 14) {
        assert.equal(orchestrator.snapshot().cycles.length, 401, 'every in-capacity active holding needs a current-day cycle')
        assert.equal(orchestrator.getHealthSnapshot().coverage, 1)
      }
    }
    const evicted = orchestrator.snapshot()
    assert.equal(evicted.cycles.length, 2000)
    assert.equal(evicted.cycles.some((item: any) => item.date === '2026-07-14' && item.code === '000001'), false,
      'the original raw high should be outside the bounded cycle detail window')
    orchestrator.recordTick({ now: new Date('2026-07-19T01:30:30Z'), positions: [], quotes: new Map([
      ['000001', { price: 110, asOf: '2026-07-19T01:30:30Z', sources: ['primary', 'tencent'] }],
    ]), benchmark: { price: 4520, asOf: '2026-07-19T01:30:30Z', sources: ['tencent'] } })
    const outcome = intelligence.snapshot().outcomes[0]!
    assert.equal(outcome.mfe, 0.5)
    assert.equal(outcome.sampleCount, 6)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('DailyResearchOrchestrator batches intelligence reads and valuation writes per tick', async () => {
  const module = await import(modulePath) as Record<string, any>
  const dir = mkdtempSync(join(tmpdir(), 'shion-daily-io-'))
  try {
    const intelligence = new ResearchIntelligenceStore(dir)
    const originalSnapshot = intelligence.snapshot.bind(intelligence)
    const originalSaveValuations = intelligence.saveValuations.bind(intelligence)
    let reads = 0; let batches = 0
    intelligence.snapshot = (() => { reads++; return originalSnapshot() }) as typeof intelligence.snapshot
    intelligence.saveValuations = ((values: Array<Record<string, unknown>>) => {
      batches++; return originalSaveValuations(values)
    }) as typeof intelligence.saveValuations
    const positions = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, code: String(i + 1).padStart(6, '0'), name: `S${i}`,
      qty: 1, cost: 100, status: 'active', updated: '2026-07-10T00:00:00Z' }))
    const quotes = new Map(positions.map(p => [p.code, { price: 100, peTtm: 10,
      asOf: '2026-07-15T01:30:00Z', sources: ['primary', 'tencent'] }]))
    new module.DailyResearchOrchestrator({ dataDir: dir, intelligence }).recordTick({
      now: new Date('2026-07-15T01:30:00Z'), positions, quotes,
      benchmark: { price: 4500, asOf: '2026-07-15T01:30:00Z', sources: ['tencent'] },
    })
    assert.equal(reads, 1)
    assert.equal(batches, 1)
    assert.equal(originalSnapshot().valuations.length, 20)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('DailyResearchOrchestrator fails closed when persisted research state is malformed', async () => {
  const module = await import(modulePath) as Record<string, any>
  const dir = mkdtempSync(join(tmpdir(), 'shion-daily-corrupt-'))
  try {
    const memoryDir = join(dir, 'memory')
    mkdirSync(memoryDir, { recursive: true })
    writeFileSync(join(memoryDir, 'daily-research.json'), JSON.stringify({
      version: 1,
      cycles: [{ date: 'tomorrow', code: '688012', status: 'healthy', latestPrice: -1 }],
      decisionTrackers: [{ decisionId: 'd1', code: '688012', action: 'buy', horizonDays: -1 }],
      coverageByDate: [{ date: '2026-07-15', latestCoverage: 2 }],
    }))
    const orchestrator = new module.DailyResearchOrchestrator({
      dataDir: dir,
      intelligence: new ResearchIntelligenceStore(dir),
    })
    assert.throws(() => orchestrator.getHealthSnapshot(), /daily research state is corrupt/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('DailyResearchOrchestrator treats a missing exited-decision quote as incomplete coverage', async () => {
  const module = await import(modulePath) as Record<string, any>
  const dir = mkdtempSync(join(tmpdir(), 'shion-daily-exited-missing-'))
  try {
    const intelligence = new ResearchIntelligenceStore(dir)
    new DecisionJournalStore(dir, { now: () => '2026-07-14T03:00:00.000Z', id: () => 'decision-exited-missing' }).record({
      action: 'sell', rationale: '风险收益比恶化', position_id: 'p1', expected_outcome: '相对基准回避损失', invalidation: '盈利超预期',
      evidence_ids: [], code: '688012', decision_price: 400, benchmark_code: '000300', benchmark_price: 4500, horizon_days: 1,
      decision_price_source: 'quorum', decision_price_as_of: '2026-07-14T02:59:59.000Z',
      benchmark_source: 'tencent', benchmark_as_of: '2026-07-14T02:59:59.000Z',
    } as any)
    const orchestrator = new module.DailyResearchOrchestrator({ dataDir: dir, intelligence })
    orchestrator.recordTick({ now: new Date('2026-07-15T03:00:30Z'), positions: [], quotes: new Map(),
      benchmark: { price: 4440, asOf: '2026-07-15T03:00:30Z', sources: ['tencent'] } })
    const health = orchestrator.getHealthSnapshot()
    assert.deepEqual(health.expected_codes, ['688012'])
    assert.deepEqual(health.missing_codes, ['688012'])
    assert.equal(health.coverage, 0)
    assert.equal(health.last_success_at, null)
    assert.match(health.last_error ?? '', /missing verified quotes: 688012/)
    assert.equal(intelligence.snapshot().outcomes.length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('DailyResearchOrchestrator does not reopen a completed decision after outcome detail eviction', async () => {
  const module = await import(modulePath) as Record<string, any>
  const dir = mkdtempSync(join(tmpdir(), 'shion-daily-completion-ledger-'))
  try {
    const intelligence = new ResearchIntelligenceStore(dir)
    writeFileSync(join(dir, 'memory', 'research-intelligence.json'), JSON.stringify({
      version: 1, quoteChecks: [], events: [], valuations: [], attributions: [], outcomes: [], sessionAudits: [],
      completedOutcomeKeys: ['decision-archived|1'],
      outcomeStats: { totalCount: 1, hitCount: 1, excessReturnSum: 0.02 },
    }))
    new DecisionJournalStore(dir, { now: () => '2026-07-14T03:00:00.000Z', id: () => 'decision-archived' }).record({
      action: 'sell', rationale: '风险收益比恶化', position_id: 'p1', expected_outcome: '相对基准回避损失', invalidation: '盈利超预期',
      evidence_ids: [], code: '688012', decision_price: 400, benchmark_code: '000300', benchmark_price: 4500, horizon_days: 1,
      decision_price_source: 'quorum', decision_price_as_of: '2026-07-14T02:59:59.000Z',
      benchmark_source: 'tencent', benchmark_as_of: '2026-07-14T02:59:59.000Z',
    } as any)
    const orchestrator = new module.DailyResearchOrchestrator({ dataDir: dir, intelligence })
    assert.deepEqual(orchestrator.pendingDecisionCodes(), [])
    assert.equal(orchestrator.getHealthSnapshot().pending_decision_count, 0)
    assert.equal(orchestrator.getHealthSnapshot().outcome_count, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('DailyResearchOrchestrator fails explicitly instead of truncating excess pending trackers', async () => {
  const module = await import(modulePath) as Record<string, any>
  const dir = mkdtempSync(join(tmpdir(), 'shion-daily-pending-capacity-'))
  try {
    const memoryDir = join(dir, 'memory')
    mkdirSync(memoryDir, { recursive: true })
    const entries = Array.from({ length: 501 }, (_, i) => ({
      id: `decision-${i}`, action: 'buy', rationale: '可证伪判断', position_id: `p-${i}`,
      expected_outcome: '跑赢基准', invalidation: '基本面恶化', evidence_ids: [], timestamp: '2026-07-14T03:00:00.000Z',
      code: String((i % 500) + 1).padStart(6, '0'), decision_price: 100, benchmark_code: '000300', benchmark_price: 4500,
      horizon_days: 20, due_at: '2026-08-03T03:00:00.000Z', decision_price_source: 'quorum',
      decision_price_as_of: '2026-07-14T02:59:59.000Z', benchmark_source: 'tencent', benchmark_as_of: '2026-07-14T02:59:59.000Z',
    }))
    writeFileSync(join(memoryDir, 'decision-journal.json'), JSON.stringify({ version: 1, entries }))
    const orchestrator = new module.DailyResearchOrchestrator({ dataDir: dir, intelligence: new ResearchIntelligenceStore(dir) })
    assert.throws(() => orchestrator.recordTick({ now: new Date('2026-07-15T03:00:30Z'), positions: [], quotes: new Map() }),
      /pending decision capacity 500 exceeded/)
    assert.match(orchestrator.getHealthSnapshot().last_error ?? '', /capacity 500 exceeded/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('DailyResearchOrchestrator fails explicitly above the active-position research capacity', async () => {
  const module = await import(modulePath) as Record<string, any>
  const dir = mkdtempSync(join(tmpdir(), 'shion-daily-active-capacity-'))
  try {
    const positions = Array.from({ length: 501 }, (_, i) => ({ id: `p${i}`, code: String(i + 1).padStart(6, '0'), name: `S${i}`,
      qty: 1, cost: 100, status: 'active', updated: '2026-07-10T00:00:00Z' }))
    const orchestrator = new module.DailyResearchOrchestrator({ dataDir: dir, intelligence: new ResearchIntelligenceStore(dir) })
    assert.throws(() => orchestrator.recordTick({ now: new Date('2026-07-15T03:00:30Z'), positions, quotes: new Map() }),
      /active position capacity 500 exceeded/)
    assert.match(orchestrator.getHealthSnapshot().last_error ?? '', /capacity 500 exceeded/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
