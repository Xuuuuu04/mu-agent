import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Position } from '../core/types.js'
import type { QuotePoint } from '../core/tencent-quotes.js'
import { atomicWriteJsonSync } from '../core/atomic-file.js'
import { beijingDateStr, beijingMinutes } from '../core/market-hours.js'
import { attributePortfolio, calculateValuationSnapshot, evaluateDecisionOutcome,
  type ResearchIntelligenceStore } from './research-intelligence.js'
import { DecisionJournalStore } from './research-store.js'
import type { DecisionEntry } from './types.js'

export interface DailyResearchTick {
  now: Date
  positions: Position[]
  quotes: Map<string, QuotePoint>
  benchmark?: QuotePoint
}

export interface PositionRiskEvidence {
  stopLoss: number | null
  takeProfit: number | null
  distanceToStopPct: number | null
  distanceToTakeProfitPct: number | null
}

export interface DailyResearchCycle {
  date: string
  code: string
  positionId: string
  name: string
  qty: number
  cost: number
  firstPrice: number
  latestPrice: number
  high: number
  low: number
  firstAsOf: string
  latestAsOf: string
  peTtm: number | null
  pb: number | null
  marketCapYi: number | null
  quoteSources: string[]
  observations: Array<{ price: number; benchmarkPrice: number | null; asOf: string }>
  sampleCount: number
  benchmarkStart: number | null
  benchmarkLatest: number | null
  benchmarkAsOf: string | null
  eventIds: string[]
  risk: PositionRiskEvidence
  status: 'collecting' | 'finalized'
  missingEvidence: string[]
  updatedAt: string
  finalizedAt?: string
}

interface CoverageSnapshot {
  date: string
  expectedCodes: string[]
  coveredCodes: string[]
  missingCodes: string[]
  latestCoverage: number
  minCoverage: number
  activeExpectedCodes: string[]
  activeCoveredCodes: string[]
  activeMissingCodes: string[]
  activeCoverage: number
  asOf: string
}

interface DecisionTracker {
  decisionId: string
  code: string
  action: 'buy' | 'add' | 'reduce' | 'sell'
  horizonDays: number
  decisionAt: string
  dueAt: string
  decisionPrice: number
  benchmarkPrice: number
  high: number
  low: number
  sampleCount: number
  lastPrice: number | null
  lastBenchmark: number | null
  lastQuoteAsOf: string | null
  lastBenchmarkAsOf: string | null
}

interface DailyResearchState {
  version: 1
  cycles: DailyResearchCycle[]
  decisionTrackers: DecisionTracker[]
  coverageByDate: CoverageSnapshot[]
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  lastError: string | null
  lastFinalizedDate: string | null
}

export interface DailyResearchHealth {
  status: 'empty' | 'collecting' | 'healthy' | 'degraded'
  last_attempt_at: string | null
  last_success_at: string | null
  last_error: string | null
  last_finalized_date: string | null
  next_run_at: string | null
  cycle_count: number
  collecting_count: number
  expected_codes: string[]
  covered_codes: string[]
  missing_codes: string[]
  coverage: number | null
  pending_decision_count: number
  due_decision_count: number
  oldest_due_at: string | null
  outcome_count: number
  outcome_hit_rate: number | null
  average_excess_return: number | null
  degraded_reasons: string[]
}

const emptyState = (): DailyResearchState => ({
  version: 1, cycles: [], decisionTrackers: [], coverageByDate: [], lastAttemptAt: null,
  lastSuccessAt: null, lastError: null, lastFinalizedDate: null,
})

const ACTIONABLE = new Set(['buy', 'add', 'reduce', 'sell'])
const MAX_PENDING_DECISIONS = 500
const MAX_ACTIVE_POSITIONS = 500
const MAX_CYCLE_DETAILS = 2_000

export class DailyResearchOrchestrator {
  private readonly path: string

  constructor(private readonly deps: { dataDir: string; intelligence: ResearchIntelligenceStore }) {
    const memoryDir = join(deps.dataDir, 'memory')
    mkdirSync(memoryDir, { recursive: true })
    this.path = join(memoryDir, 'daily-research.json')
  }

  pendingDecisionCodes(): string[] {
    const completed = new Set(this.deps.intelligence.snapshot().completedOutcomeKeys)
    return [...new Set(this.actionableDecisions().filter(item => !completed.has(`${item.id}|${item.horizon_days}`))
      .map(item => item.code!))].slice(0, MAX_PENDING_DECISIONS)
  }

  recordTick(input: DailyResearchTick): void {
    if (beijingMinutes(input.now) < 9 * 60 + 30) return
    const state = this.load()
    const nowIso = input.now.toISOString()
    const date = beijingDateStr(input.now)
    const benchmark = freshQuote(input.benchmark, input.now) ? input.benchmark : undefined
    state.lastAttemptAt = nowIso
    try {
      if (input.positions.length > MAX_ACTIVE_POSITIONS) {
        throw new Error(`active position capacity ${MAX_ACTIVE_POSITIONS} exceeded; reduce or archive positions`)
      }
      const intelligence = this.deps.intelligence.snapshot()
      const decisions = this.actionableDecisions()
      const completed = new Set(intelligence.completedOutcomeKeys)
      const pendingDecisions = decisions.filter(item => !completed.has(`${item.id}|${item.horizon_days}`))
      if (pendingDecisions.length > MAX_PENDING_DECISIONS) {
        throw new Error(`pending decision capacity ${MAX_PENDING_DECISIONS} exceeded; archive or resolve decisions`)
      }
      const abandonedDates = [...new Set(state.cycles
        .filter(item => item.date !== date && item.status === 'collecting').map(item => item.date))]
      for (const abandonedDate of abandonedDates) {
        const prior = state.cycles.filter(item => item.date === abandonedDate)
        const lastAsOf = prior.map(item => item.latestAsOf).sort().at(-1)
        if (lastAsOf) this.finalizeDate(state, abandonedDate, new Date(lastAsOf), 'next trading day recovery')
      }

      const expectedResearchCodes = [...new Set([
        ...input.positions.map(item => item.code),
        ...pendingDecisions.map(item => item.code!),
      ])]
      this.updateCoverage(state, date, input.positions.map(item => item.code), expectedResearchCodes, input.quotes, input.now)
      const valuationIds = new Set(intelligence.valuations.map(item => `${item.code}|${item.valuationDate}`))
      const valuations: Array<Record<string, unknown>> = []
      const eventsByCode = new Map<string, string[]>()
      for (const event of intelligence.events) {
        for (const code of event.relatedCodes) {
          if (beijingDateStr(new Date(event.publishedAt)) !== date) continue
          const ids = eventsByCode.get(code) ?? []
          if (!ids.includes(event.id)) ids.push(event.id)
          eventsByCode.set(code, ids.slice(-20))
        }
      }

      for (const position of input.positions) {
        const quote = input.quotes.get(position.code)
        if (!freshQuote(quote, input.now)) continue
        const existing = state.cycles.find(item => item.date === date && item.code === position.code)
        const missing = researchGaps(quote, benchmark)
        const risk = riskEvidence(position, quote.price)
        const eventIds = eventsByCode.get(position.code) ?? []
        if (existing) {
          const persistent = existing.missingEvidence.filter(reason => reason === 'intraday position changes are not modeled')
          if (existing.qty !== position.qty && !persistent.includes('intraday position changes are not modeled')) {
            persistent.push('intraday position changes are not modeled')
          }
          existing.latestPrice = quote.price
          existing.latestAsOf = quote.asOf
          existing.high = Math.max(existing.high, quote.price)
          existing.low = Math.min(existing.low, quote.price)
          existing.peTtm = finitePositive(quote.peTtm) ? quote.peTtm! : existing.peTtm
          existing.pb = finitePositive(quote.pb) ? quote.pb! : existing.pb
          existing.marketCapYi = finitePositive(quote.marketCapYi) ? quote.marketCapYi! : existing.marketCapYi
          existing.quoteSources = quote.sources?.length ? [...quote.sources] : existing.quoteSources
          existing.benchmarkLatest = finitePositive(benchmark?.price) ? benchmark!.price : existing.benchmarkLatest
          existing.benchmarkAsOf = explicitTimestamp(benchmark?.asOf ?? '') ? benchmark!.asOf : existing.benchmarkAsOf
          existing.eventIds = [...new Set([...existing.eventIds, ...eventIds])].slice(-20)
          existing.risk = risk
          existing.missingEvidence = [...new Set([...missing, ...persistent])]
          existing.observations ??= [{ price: existing.firstPrice, benchmarkPrice: existing.benchmarkStart, asOf: existing.firstAsOf }]
          if (!existing.observations.some(item => item.asOf === quote.asOf)) {
            existing.observations.push({ price: quote.price,
              benchmarkPrice: finitePositive(benchmark?.price) ? benchmark!.price : null, asOf: quote.asOf })
            existing.observations = existing.observations.slice(-160)
          }
          existing.sampleCount = existing.observations.length
          existing.updatedAt = nowIso
        } else {
          state.cycles.push({
            date, code: position.code, positionId: position.id, name: position.name, qty: position.qty, cost: position.cost,
            firstPrice: quote.price, latestPrice: quote.price, high: quote.price, low: quote.price,
            firstAsOf: quote.asOf, latestAsOf: quote.asOf,
            peTtm: finitePositive(quote.peTtm) ? quote.peTtm! : null,
            pb: finitePositive(quote.pb) ? quote.pb! : null,
            marketCapYi: finitePositive(quote.marketCapYi) ? quote.marketCapYi! : null,
            quoteSources: quote.sources ? [...quote.sources] : [],
            observations: [{ price: quote.price,
              benchmarkPrice: finitePositive(benchmark?.price) ? benchmark!.price : null, asOf: quote.asOf }],
            sampleCount: 1,
            benchmarkStart: finitePositive(benchmark?.price) ? benchmark!.price : null,
            benchmarkLatest: finitePositive(benchmark?.price) ? benchmark!.price : null,
            benchmarkAsOf: explicitTimestamp(benchmark?.asOf ?? '') ? benchmark!.asOf : null,
            eventIds, risk, status: 'collecting', missingEvidence: missing, updatedAt: nowIso,
          })
        }
        const valuation = this.buildValuation(date, position.code, quote, valuationIds)
        if (valuation) { valuations.push(valuation); valuationIds.add(`${position.code}|${date}`) }
      }
      if (valuations.length) this.deps.intelligence.saveValuations(valuations)
      this.updateDecisionTrackers(state, decisions, completed, input, benchmark)
      const currentCycles = state.cycles.filter(item => item.date === date)
      const historicalCycles = state.cycles.filter(item => item.date !== date)
        .slice(-(MAX_CYCLE_DETAILS - currentCycles.length))
      state.cycles = [...historicalCycles, ...currentCycles]
      state.coverageByDate = state.coverageByDate.slice(-30)
      const coverage = state.coverageByDate.find(item => item.date === date)
      if (!coverage || coverage.latestCoverage === 1) {
        state.lastSuccessAt = nowIso
        state.lastError = null
      } else {
        state.lastError = `missing verified quotes: ${coverage.missingCodes.join(', ')}`
      }
      this.save(state)
    } catch (error) {
      state.lastError = (error as Error).message
      this.save(state)
      throw error
    }
  }

  finalize(now: Date): void {
    const state = this.load()
    this.finalizeDate(state, beijingDateStr(now), now)
    this.save(state)
  }

  snapshot(): DailyResearchState { return structuredClone(this.load()) }

  getHealthSnapshot(): DailyResearchHealth {
    const state = this.load()
    const latestDate = [state.cycles.at(-1)?.date, state.coverageByDate.at(-1)?.date]
      .filter((value): value is string => typeof value === 'string').sort().at(-1)
    const latest = latestDate ? state.cycles.filter(item => item.date === latestDate) : []
    const coverage = latestDate ? state.coverageByDate.find(item => item.date === latestDate) : undefined
    const decisions = this.actionableDecisions()
    const intelligence = this.deps.intelligence.snapshot()
    const completed = new Set(intelligence.completedOutcomeKeys)
    const pending = decisions.filter(item => !completed.has(`${item.id}|${item.horizon_days}`))
    const now = Date.now()
    const due = pending.filter(item => Date.parse(item.due_at!) <= now)
    const outcomeStats = intelligence.outcomeStats
    const reasons = [...new Set([
      ...latest.flatMap(item => item.missingEvidence),
      ...(latest.length ? ['account cash and external cash flows are not configured'] : []),
      ...(coverage?.missingCodes.length ? [`missing verified quotes: ${coverage.missingCodes.join(', ')}`] : []),
    ])]
    const status: DailyResearchHealth['status'] = state.lastError || reasons.length ? 'degraded'
      : latest.length === 0 ? 'empty' : latest.some(item => item.status === 'collecting') ? 'collecting' : 'healthy'
    return { status, last_attempt_at: state.lastAttemptAt, last_success_at: state.lastSuccessAt,
      last_error: state.lastError, last_finalized_date: state.lastFinalizedDate, next_run_at: null,
      cycle_count: state.cycles.length, collecting_count: state.cycles.filter(item => item.status === 'collecting').length,
      expected_codes: coverage?.expectedCodes ?? [], covered_codes: coverage?.coveredCodes ?? [],
      missing_codes: coverage?.missingCodes ?? [], coverage: coverage?.latestCoverage ?? null,
      pending_decision_count: pending.length, due_decision_count: due.length,
      oldest_due_at: pending.map(item => item.due_at!).sort().at(0) ?? null,
      outcome_count: outcomeStats.totalCount,
      outcome_hit_rate: outcomeStats.totalCount ? round(outcomeStats.hitCount / outcomeStats.totalCount, 4) : null,
      average_excess_return: outcomeStats.totalCount ? round(outcomeStats.excessReturnSum / outcomeStats.totalCount, 6) : null,
      degraded_reasons: reasons }
  }

  private finalizeDate(state: DailyResearchState, date: string, now: Date, finalizationReason = 'scheduled market close'): void {
    const cycles = state.cycles.filter(item => item.date === date)
    if (cycles.length === 0) return
    const existing = this.deps.intelligence.snapshot().attributions.some(item => item.date === date)
    if (!existing) {
      const startEquity = cycles.reduce((sum, item) => sum + item.qty * item.firstPrice, 0)
      const actualEndEquity = cycles.reduce((sum, item) => sum + item.qty * item.latestPrice, 0)
      const benchmark = cycles.find(item => finitePositive(item.benchmarkStart) && finitePositive(item.benchmarkLatest))
      const benchmarkReturn = benchmark ? benchmark.benchmarkLatest! / benchmark.benchmarkStart! - 1 : 0
      const result = attributePortfolio({ startEquity, actualEndEquity, netCashFlow: 0, benchmarkReturn,
        fees: 0, slippage: 0, positions: cycles.map(item => ({ code: item.code, sector: '未分类', qty: item.qty,
          startPrice: item.firstPrice, endPrice: item.latestPrice })) })
      const coverage = state.coverageByDate.find(item => item.date === date)
      const attributionMissingCodes = coverage?.activeMissingCodes ?? []
      const degradedReasons = ['account cash and external cash flows are not configured',
        'fees and slippage are not available for held-position mark-to-market',
        ...(!benchmark ? ['benchmark is unavailable'] : []),
        ...(attributionMissingCodes.length ? [`missing verified quotes: ${attributionMissingCodes.join(', ')}`] : []),
        ...(cycles.some(item => item.missingEvidence.includes('intraday position changes are not modeled'))
          ? ['intraday position changes are not modeled'] : [])]
      this.deps.intelligence.saveAttribution({ date, asOf: now.toISOString(), scope: 'active_positions_only', status: 'degraded',
        finalizationReason, degradedReasons, availability: { accountCash: false, externalCashFlows: false, fees: false, slippage: false },
        coverage: coverage?.activeCoverage ?? null,
        missingCodes: attributionMissingCodes, ...result,
        ...(!benchmark ? { benchmarkReturn: null, excessReturn: null } : {}) })
    }
    for (const cycle of cycles) {
      cycle.status = 'finalized'; cycle.finalizedAt = now.toISOString(); cycle.updatedAt = now.toISOString()
    }
    state.lastFinalizedDate = date
    if (!state.lastError) state.lastSuccessAt = now.toISOString()
  }

  private buildValuation(date: string, code: string, quote: QuotePoint, identities: Set<string>): Record<string, unknown> | null {
    if (!quote.sources?.length || identities.has(`${code}|${date}`)) return null
    const epsTtm = finitePositive(quote.peTtm) ? quote.price / quote.peTtm! : undefined
    const bookValuePerShare = finitePositive(quote.pb) ? quote.price / quote.pb! : undefined
    if (epsTtm === undefined && bookValuePerShare === undefined) return null
    const evidence = {
      price: { source: `verified:${quote.sources.join('+')}`, asOf: quote.asOf },
      ...(epsTtm === undefined ? {} : { epsTtm: { source: 'tencent-derived-pe-ttm', asOf: quote.asOf } }),
      ...(bookValuePerShare === undefined ? {} : { bookValuePerShare: { source: 'tencent-derived-pb', asOf: quote.asOf } }),
    }
    return { valuationDate: date, ...calculateValuationSnapshot({ code, asOf: quote.asOf,
      price: quote.price, epsTtm, bookValuePerShare, evidence }) }
  }

  private updateCoverage(state: DailyResearchState, date: string, activeCodes: string[], codes: string[],
    quotes: Map<string, QuotePoint>, now: Date): void {
    const expectedCodes = [...new Set(codes)].sort()
    const coveredCodes = expectedCodes.filter(code => freshQuote(quotes.get(code), now))
    const missingCodes = expectedCodes.filter(code => !coveredCodes.includes(code))
    const latestCoverage = expectedCodes.length ? round(coveredCodes.length / expectedCodes.length, 4) : 1
    const activeExpectedCodes = [...new Set(activeCodes)].sort()
    const activeCoveredCodes = activeExpectedCodes.filter(code => coveredCodes.includes(code))
    const activeMissingCodes = activeExpectedCodes.filter(code => !activeCoveredCodes.includes(code))
    const activeCoverage = activeExpectedCodes.length ? round(activeCoveredCodes.length / activeExpectedCodes.length, 4) : 1
    const existing = state.coverageByDate.find(item => item.date === date)
    if (existing) {
      existing.expectedCodes = expectedCodes; existing.coveredCodes = coveredCodes; existing.missingCodes = missingCodes
      existing.latestCoverage = latestCoverage; existing.minCoverage = Math.min(existing.minCoverage, latestCoverage)
      existing.activeExpectedCodes = activeExpectedCodes; existing.activeCoveredCodes = activeCoveredCodes
      existing.activeMissingCodes = activeMissingCodes; existing.activeCoverage = activeCoverage
      existing.asOf = now.toISOString()
    } else state.coverageByDate.push({ date, expectedCodes, coveredCodes, missingCodes,
      latestCoverage, minCoverage: latestCoverage, activeExpectedCodes, activeCoveredCodes,
      activeMissingCodes, activeCoverage, asOf: now.toISOString() })
  }

  private updateDecisionTrackers(state: DailyResearchState, decisions: DecisionEntry[], completed: Set<string>,
    input: DailyResearchTick, benchmark?: QuotePoint): void {
    const pending = decisions.filter(item => !completed.has(`${item.id}|${item.horizon_days}`))
    const pendingIds = new Set(pending.map(item => item.id))
    state.decisionTrackers = state.decisionTrackers.filter(item => pendingIds.has(item.decisionId))
    for (const decision of pending) {
      const quote = input.quotes.get(decision.code!)
      let tracker = state.decisionTrackers.find(item => item.decisionId === decision.id)
      if (!tracker) {
        tracker = { decisionId: decision.id, code: decision.code!, action: decision.action as DecisionTracker['action'],
          horizonDays: decision.horizon_days!, decisionAt: decision.timestamp, dueAt: decision.due_at!,
          decisionPrice: decision.decision_price!, benchmarkPrice: decision.benchmark_price!,
          high: decision.decision_price!, low: decision.decision_price!, sampleCount: 0,
          lastPrice: null, lastBenchmark: null, lastQuoteAsOf: null, lastBenchmarkAsOf: null }
        state.decisionTrackers.push(tracker)
      }
      if (!freshQuote(quote, input.now) || Date.parse(quote.asOf) < Date.parse(decision.timestamp)
        || tracker.lastQuoteAsOf === quote.asOf) continue
      tracker.high = Math.max(tracker.high, quote.price); tracker.low = Math.min(tracker.low, quote.price)
      tracker.sampleCount++; tracker.lastPrice = quote.price; tracker.lastQuoteAsOf = quote.asOf
      if (benchmark && Date.parse(benchmark.asOf) >= Date.parse(decision.timestamp)) {
        tracker.lastBenchmark = benchmark.price; tracker.lastBenchmarkAsOf = benchmark.asOf
      }
      const due = Date.parse(decision.due_at!)
      if (Date.parse(quote.asOf) < due || !benchmark || Date.parse(benchmark.asOf) < due
        || Math.abs(Date.parse(quote.asOf) - Date.parse(benchmark.asOf)) > 5 * 60_000) continue
      const metrics = evaluateDecisionOutcome({ action: tracker.action, decisionPrice: tracker.decisionPrice,
        benchmarkPrice: tracker.benchmarkPrice, observedPrice: quote.price, observedBenchmark: benchmark.price,
        high: tracker.high, low: tracker.low })
      this.deps.intelligence.saveOutcome({ decisionId: decision.id, code: decision.code,
        horizonDays: decision.horizon_days, decisionAt: decision.timestamp, dueAt: decision.due_at,
        observedAt: quote.asOf, observedQuoteAsOf: quote.asOf, observedBenchmarkAsOf: benchmark.asOf,
        observedPrice: quote.price, observedBenchmark: benchmark.price, high: tracker.high, low: tracker.low,
        observationPolicy: 'first verified paired quote at or after due', pathSampling: 'bounded per-decision accumulator',
        sampleCount: tracker.sampleCount, decisionPriceSource: decision.decision_price_source,
        decisionPriceAsOf: decision.decision_price_as_of, benchmarkSource: decision.benchmark_source,
        benchmarkAsOf: decision.benchmark_as_of, ...metrics })
      completed.add(`${decision.id}|${decision.horizon_days}`)
    }
    state.decisionTrackers = state.decisionTrackers.filter(item => !completed.has(`${item.decisionId}|${item.horizonDays}`))
  }

  private actionableDecisions(): DecisionEntry[] {
    return new DecisionJournalStore(this.deps.dataDir).list().filter(item => ACTIONABLE.has(item.action)
      && item.code && finitePositive(item.decision_price) && finitePositive(item.benchmark_price)
      && item.horizon_days && item.due_at) as DecisionEntry[]
  }

  private load(): DailyResearchState {
    if (!existsSync(this.path)) return emptyState()
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as unknown
      if (!validDailyResearchState(raw)) throw new Error('invalid schema')
      return raw
    } catch (error) {
      throw new Error('daily research state is corrupt', { cause: error })
    }
  }

  private save(state: DailyResearchState): void { atomicWriteJsonSync(this.path, state, 2) }
}

function researchGaps(quote: QuotePoint, benchmark?: QuotePoint): string[] {
  const gaps = ['forward consensus EPS is unavailable']
  if (!quote.sources?.length) gaps.push('quote source provenance is unavailable')
  if (!finitePositive(quote.peTtm)) gaps.push('trailing PE is unavailable')
  if (!finitePositive(quote.pb)) gaps.push('price-to-book is unavailable')
  if (!finitePositive(benchmark?.price)) gaps.push('benchmark is unavailable')
  return gaps
}

function riskEvidence(position: Position, price: number): PositionRiskEvidence {
  const stopLoss = finitePositive(position.stop_loss) ? position.stop_loss! : null
  const takeProfit = finitePositive(position.take_profit) ? position.take_profit! : null
  return { stopLoss, takeProfit,
    distanceToStopPct: stopLoss === null ? null : round((price - stopLoss) / price, 4),
    distanceToTakeProfitPct: takeProfit === null ? null : round((takeProfit - price) / price, 4) }
}

function finitePositive(value: number | undefined | null): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function explicitTimestamp(value: string): boolean {
  return /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value))
}

function freshQuote(value: QuotePoint | undefined, now: Date): value is QuotePoint {
  if (!value || !finitePositive(value.price) || !explicitTimestamp(value.asOf)) return false
  const age = now.getTime() - Date.parse(value.asOf)
  return age >= -5_000 && age <= 5 * 60_000
}

function round(value: number, digits: number): number { return Number(value.toFixed(digits)) }

function validDailyResearchState(value: unknown): value is DailyResearchState {
  if (!record(value) || value.version !== 1 || !Array.isArray(value.cycles) || value.cycles.length > MAX_CYCLE_DETAILS
    || !value.cycles.every(validCycle) || !cycleDatesWithinCapacity(value.cycles) || !Array.isArray(value.decisionTrackers)
    || value.decisionTrackers.length > MAX_PENDING_DECISIONS || !value.decisionTrackers.every(validTracker)
    || new Set(value.decisionTrackers.map(item => record(item) ? item.decisionId : null)).size !== value.decisionTrackers.length
    || !Array.isArray(value.coverageByDate) || value.coverageByDate.length > 30
    || !value.coverageByDate.every(validCoverage)) return false
  return nullTimestamp(value.lastAttemptAt) && nullTimestamp(value.lastSuccessAt)
    && (value.lastError === null || typeof value.lastError === 'string')
    && (value.lastFinalizedDate === null || validDate(value.lastFinalizedDate))
}

function cycleDatesWithinCapacity(cycles: DailyResearchCycle[]): boolean {
  const counts = new Map<string, number>()
  for (const cycle of cycles) {
    const count = (counts.get(cycle.date) ?? 0) + 1
    if (count > MAX_ACTIVE_POSITIONS) return false
    counts.set(cycle.date, count)
  }
  return true
}

function validCycle(value: unknown): value is DailyResearchCycle {
  if (!record(value) || !validDate(value.date) || !stockCode(value.code)
    || typeof value.positionId !== 'string' || typeof value.name !== 'string'
    || !positive(value.qty) || !nonNegative(value.cost)
    || !positive(value.firstPrice) || !positive(value.latestPrice) || !positive(value.high) || !positive(value.low)
    || value.high < value.low || value.high < value.firstPrice || value.high < value.latestPrice
    || value.low > value.firstPrice || value.low > value.latestPrice
    || !explicitTimestamp(String(value.firstAsOf ?? '')) || !explicitTimestamp(String(value.latestAsOf ?? ''))
    || !nullablePositive(value.peTtm) || !nullablePositive(value.pb) || !nullablePositive(value.marketCapYi)
    || !stringArray(value.quoteSources) || !Array.isArray(value.observations)
    || !value.observations.every(validObservation) || !integerAtLeast(value.sampleCount, 1)
    || value.sampleCount !== value.observations.length
    || !nullablePositive(value.benchmarkStart) || !nullablePositive(value.benchmarkLatest)
    || !nullableTimestamp(value.benchmarkAsOf) || !stringArray(value.eventIds)
    || !validRisk(value.risk) || !['collecting', 'finalized'].includes(String(value.status))
    || !stringArray(value.missingEvidence) || !explicitTimestamp(String(value.updatedAt ?? ''))
    || (value.finalizedAt !== undefined && !explicitTimestamp(String(value.finalizedAt)))) return false
  return value.status !== 'finalized' || explicitTimestamp(String(value.finalizedAt ?? ''))
}

function validObservation(value: unknown): boolean {
  return record(value) && positive(value.price) && nullablePositive(value.benchmarkPrice)
    && explicitTimestamp(String(value.asOf ?? ''))
}

function validRisk(value: unknown): value is PositionRiskEvidence {
  return record(value) && nullablePositive(value.stopLoss) && nullablePositive(value.takeProfit)
    && nullableFinite(value.distanceToStopPct) && nullableFinite(value.distanceToTakeProfitPct)
}

function validTracker(value: unknown): value is DecisionTracker {
  if (!record(value) || typeof value.decisionId !== 'string' || value.decisionId.length === 0
    || !stockCode(value.code) || !ACTIONABLE.has(String(value.action))
    || !integerAtLeast(value.horizonDays, 1)
    || !explicitTimestamp(String(value.decisionAt ?? '')) || !explicitTimestamp(String(value.dueAt ?? ''))
    || Date.parse(String(value.dueAt)) < Date.parse(String(value.decisionAt))
    || !positive(value.decisionPrice) || !positive(value.benchmarkPrice)
    || !positive(value.high) || !positive(value.low) || value.high < value.low
    || value.high < value.decisionPrice || value.low > value.decisionPrice
    || !integerAtLeast(value.sampleCount, 0) || !nullablePositive(value.lastPrice)
    || !nullablePositive(value.lastBenchmark) || !nullableTimestamp(value.lastQuoteAsOf)
    || !nullableTimestamp(value.lastBenchmarkAsOf)) return false
  return (value.lastPrice === null) === (value.lastQuoteAsOf === null)
    && (value.lastBenchmark === null) === (value.lastBenchmarkAsOf === null)
}

function validCoverage(value: unknown): value is CoverageSnapshot {
  if (!record(value) || !validDate(value.date) || !stockCodeArray(value.expectedCodes)
    || !stockCodeArray(value.coveredCodes) || !stockCodeArray(value.missingCodes)
    || !ratio(value.latestCoverage) || !ratio(value.minCoverage) || value.minCoverage > value.latestCoverage
    || !stockCodeArray(value.activeExpectedCodes) || !stockCodeArray(value.activeCoveredCodes)
    || !stockCodeArray(value.activeMissingCodes) || !ratio(value.activeCoverage)
    || !explicitTimestamp(String(value.asOf ?? ''))) return false
  return validCoveragePartition(value.expectedCodes, value.coveredCodes, value.missingCodes, value.latestCoverage)
    && validCoveragePartition(value.activeExpectedCodes, value.activeCoveredCodes, value.activeMissingCodes, value.activeCoverage)
    && value.activeExpectedCodes.every(code => value.expectedCodes.includes(code))
}

function validCoveragePartition(expectedCodes: string[], coveredCodes: string[], missingCodes: string[], coverage: number): boolean {
  const expected = new Set(expectedCodes); const covered = new Set(coveredCodes); const missing = new Set(missingCodes)
  if (expected.size !== expectedCodes.length || covered.size !== coveredCodes.length || missing.size !== missingCodes.length) return false
  if ([...covered, ...missing].some(code => !expected.has(code))
    || [...covered].some(code => missing.has(code)) || covered.size + missing.size !== expected.size) return false
  return (expected.size ? round(covered.size / expected.size, 4) : 1) === coverage
}

function record(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
}

function stockCode(value: unknown): value is string { return typeof value === 'string' && /^\d{6}$/.test(value) }
function stockCodeArray(value: unknown): value is string[] { return Array.isArray(value) && value.every(stockCode) }
function stringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === 'string') }
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value > 0 }
function nonNegative(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 }
function nullablePositive(value: unknown): value is number | null { return value === null || positive(value) }
function nullableFinite(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}
function ratio(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 }
function integerAtLeast(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum
}
function nullableTimestamp(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || (typeof value === 'string' && explicitTimestamp(value))
}
function nullTimestamp(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && explicitTimestamp(value))
}
