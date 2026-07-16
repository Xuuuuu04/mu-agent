import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-file.js'

export interface QuoteObservation { source: string; price: number; asOf: string }
export interface QuotePolicy { maxAgeSeconds: number; toleranceBps: number; minSources: number }

export function reconcileQuotes(observations: QuoteObservation[], now: Date, policy: QuotePolicy) {
  const seenSources = new Set<string>()
  const fresh = observations.filter(item => {
    const at = Date.parse(item.asOf)
    const valid = item.source.length > 0 && !seenSources.has(item.source) && Number.isFinite(item.price) && item.price > 0
      && Number.isFinite(at) && at <= now.getTime() + 1000
      && now.getTime() - at <= policy.maxAgeSeconds * 1000
    if (valid) seenSources.add(item.source)
    return valid
  }).sort((a, b) => a.price - b.price)
  if (fresh.length === 0) return {
    status: 'unavailable' as const, consensusPrice: null, acceptedSources: [],
    rejectedSources: observations.map(x => x.source).sort(), dispersionBps: null,
  }
  const median = fresh[Math.floor(fresh.length / 2)]!.price
  const accepted = fresh.filter(x => Math.abs(x.price / median - 1) * 10_000 <= policy.toleranceBps)
  const acceptedNames = accepted.map(x => x.source).sort()
  const rejectedNames = observations.filter(x => !accepted.includes(x)).map(x => x.source).sort()
  if (accepted.length < policy.minSources) return {
    status: fresh.length >= policy.minSources ? 'divergent' as const : accepted.length ? 'degraded' as const : 'unavailable' as const,
    consensusPrice: accepted.length ? round(median, 4) : null,
    acceptedSources: acceptedNames, rejectedSources: rejectedNames, dispersionBps: null,
  }
  const prices = accepted.map(x => x.price)
  const dispersionBps = round((Math.max(...prices) / Math.min(...prices) - 1) * 10_000, 2)
  return {
    status: rejectedNames.length ? 'divergent' as const : 'consistent' as const,
    consensusPrice: round(median, 4), acceptedSources: acceptedNames,
    rejectedSources: rejectedNames, dispersionBps,
  }
}

export interface RawMarketEvent { source: string; title: string; publishedAt: string; url?: string; content?: string; codeHints?: string[] }
export interface MarketEvent extends RawMarketEvent {
  id: string
  severity: 'critical' | 'high' | 'normal'
  relatedCodes: string[]
  requiresAlert: boolean
}

export function mergeMarketEvents(existing: MarketEvent[], incoming: RawMarketEvent[], positionCodes: string[]): MarketEvent[] {
  const map = new Map(existing.map(x => [x.id, x]))
  for (const original of incoming.slice(0, 500)) {
    const raw = { ...original, title: original.title.slice(0, 500),
      ...(original.url === undefined ? {} : { url: original.url.slice(0, 2000) }),
      ...(original.content === undefined ? {} : { content: original.content.slice(0, 8000) }) }
    if (!raw.source || !raw.title || !Number.isFinite(Date.parse(raw.publishedAt))) continue
    const canonical = `${raw.source}|${raw.url ?? ''}|${raw.title.trim()}|${raw.publishedAt}`
    const id = createHash('sha256').update(canonical).digest('hex').slice(0, 20)
    const relatedCodes = positionCodes.filter(code => raw.codeHints?.includes(code) || raw.title.includes(code) || raw.content?.includes(code)).sort()
    const prior = map.get(id) ?? [...map.values()].find(event => equivalentCompanyEvent(event, raw, relatedCodes))
    if (prior) {
      const mergedCodes = [...new Set([...prior.relatedCodes, ...relatedCodes])].sort()
      map.set(prior.id, { ...prior,
        ...(prior.url === undefined && raw.url !== undefined ? { url: raw.url } : {}),
        ...(prior.content === undefined && raw.content !== undefined ? { content: raw.content } : {}),
        relatedCodes: mergedCodes, requiresAlert: mergedCodes.length > 0 && prior.severity !== 'normal' })
      continue
    }
    const critical = /停牌|重大资产重组|退市|立案|处罚|风险警示|债务违约|控制权变更/.test(`${raw.title} ${raw.content ?? ''}`)
    const high = critical || /业绩预告|减持|增持|回购|解禁|分红|中标|诉讼/.test(`${raw.title} ${raw.content ?? ''}`)
    const severity = critical ? 'critical' : high ? 'high' : 'normal'
    const event: RawMarketEvent = { source: raw.source, title: raw.title, publishedAt: raw.publishedAt,
      ...(raw.url === undefined ? {} : { url: raw.url }), ...(raw.content === undefined ? {} : { content: raw.content }) }
    map.set(id, { ...event, id, severity, relatedCodes, requiresAlert: relatedCodes.length > 0 && severity !== 'normal' })
  }
  const rank = { critical: 2, high: 1, normal: 0 }
  return [...map.values()].sort((a, b) => rank[b.severity] - rank[a.severity]
    || Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
}

function equivalentCompanyEvent(existing: MarketEvent, incoming: RawMarketEvent, relatedCodes: string[]): boolean {
  if (relatedCodes.length === 0 || !existing.relatedCodes.some(code => relatedCodes.includes(code))) return false
  return normalizedEventTitle(existing.title) === normalizedEventTitle(incoming.title)
    && beijingEventDate(existing.publishedAt) === beijingEventDate(incoming.publishedAt)
}

function normalizedEventTitle(value: string): string {
  return value.replace(/\s+/g, '').replace(/[：:]/g, ':').trim()
}

function beijingEventDate(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

export interface ValuationInput {
  code: string; asOf: string; price: number; epsTtm?: number; bookValuePerShare?: number
  forwardEps?: number; nextForwardEps?: number; analystCount?: number
  targetPe?: { bear: number; base: number; bull: number }
  evidence: Partial<Record<'price' | 'epsTtm' | 'bookValuePerShare' | 'forwardEps' | 'nextForwardEps', { source: string; asOf: string }>>
}

export function calculateValuationSnapshot(input: ValuationInput) {
  const safe = (value: number | undefined) => Number.isFinite(value) && value! > 0 ? value! : null
  const price = safe(input.price)
  if (!price || !/^\d{6}$/.test(input.code) || !explicitTimestamp(input.asOf)) throw new Error('invalid valuation input')
  for (const [field, value] of Object.entries({ epsTtm: input.epsTtm, bookValuePerShare: input.bookValuePerShare,
    forwardEps: input.forwardEps, nextForwardEps: input.nextForwardEps })) {
    if (value !== undefined && !Number.isFinite(value)) throw new Error(`invalid ${field}`)
  }
  const snapshotTime = Date.parse(input.asOf)
  const epsTtm = safe(input.epsTtm)
  const bvps = safe(input.bookValuePerShare)
  const forward = safe(input.forwardEps)
  const next = safe(input.nextForwardEps)
  const growth = forward && next ? next / forward - 1 : null
  const forwardPe = forward ? price / forward : null
  const peg = forwardPe && growth && growth > 0 ? forwardPe / (growth * 100) : null
  const target = input.targetPe ?? null
  if (target) {
    for (const value of Object.values(target)) if (!Number.isFinite(value) || value <= 0) throw new Error('invalid target PE')
    if (!(target.bear <= target.base && target.base <= target.bull)) throw new Error('target PE scenarios must be bear <= base <= bull')
  }
  if (forward && !target) throw new Error('target PE scenarios are required when forward EPS is provided')
  if (input.analystCount !== undefined && (!Number.isInteger(input.analystCount) || input.analystCount < 0)) throw new Error('invalid analyst count')
  const values = { price: input.price, epsTtm: input.epsTtm, bookValuePerShare: input.bookValuePerShare,
    forwardEps: input.forwardEps, nextForwardEps: input.nextForwardEps }
  const maxAgeDays = { price: 1, epsTtm: 550, bookValuePerShare: 550, forwardEps: 200, nextForwardEps: 200 }
  const evidenceCoverage: Record<string, Record<string, unknown>> = {}
  for (const [field, value] of Object.entries(values) as Array<[keyof typeof values, number | undefined]>) {
    const evidence = input.evidence[field]
    if (value === undefined) { evidenceCoverage[field] = { status: 'missing', reason: 'value not provided' }; continue }
    if (!evidence?.source.trim() || !explicitTimestamp(evidence.asOf)) throw new Error(`missing or invalid ${field} evidence`)
    const ageDays = (snapshotTime - Date.parse(evidence.asOf)) / 86_400_000
    if (ageDays < -1 / 1440) throw new Error(`${field} evidence is from the future`)
    evidenceCoverage[field] = { source: evidence.source.trim(), asOf: evidence.asOf, ageDays: round(Math.max(0, ageDays), 2),
      status: ageDays > maxAgeDays[field] ? 'stale' : 'available', ...(ageDays > maxAgeDays[field] ? { reason: `older than ${maxAgeDays[field]} days` } : {}) }
  }
  const hasStale = Object.values(evidenceCoverage).some(value => value.status === 'stale')
  const available = (field: string) => evidenceCoverage[field]?.status === 'available'
  const evidenceCoverageLevel = hasStale ? 'degraded'
    : available('price') && available('forwardEps') && available('nextForwardEps') && (input.analystCount ?? 0) >= 10 ? 'high'
    : available('price') && ['epsTtm', 'bookValuePerShare', 'forwardEps'].some(available) ? 'medium' : 'low'
  return {
    code: input.code, asOf: input.asOf, price,
    peTtm: epsTtm ? round(price / epsTtm, 2) : null,
    pb: bvps ? round(price / bvps, 2) : null,
    forwardPe: forwardPe ? round(forwardPe, 2) : null,
    growth: growth === null ? null : round(growth, 4),
    peg: peg === null ? null : round(peg, 2),
    scenarioValues: forward && target ? {
      bear: round(forward * target.bear, 2), base: round(forward * target.base, 2), bull: round(forward * target.bull, 2),
    } : null,
    analystCount: input.analystCount ?? 0,
    coverage: evidenceCoverageLevel,
    evidenceCoverage,
    assumptions: { targetPe: target ? { ...target } : null, forwardEps: forward, nextForwardEps: next },
  }
}

export interface AttributionInput {
  startEquity: number; actualEndEquity: number; netCashFlow: number; benchmarkReturn: number; fees: number; slippage: number
  positions: Array<{ code: string; sector: string; qty: number; startPrice: number; endPrice: number }>
}

export function attributePortfolio(input: AttributionInput) {
  if (![input.startEquity, input.actualEndEquity, input.netCashFlow, input.benchmarkReturn, input.fees, input.slippage].every(Number.isFinite)
    || input.startEquity <= 0 || input.actualEndEquity < 0 || input.fees < 0 || input.slippage < 0) {
    throw new Error('invalid attribution input')
  }
  const positionPnl: Record<string, number> = {}
  const sectorPnl: Record<string, number> = {}
  const positionStartValue: Record<string, number> = {}
  const sectorStartValue: Record<string, number> = {}
  for (const p of input.positions) {
    if (![p.qty, p.startPrice, p.endPrice].every(Number.isFinite) || p.qty < 0 || p.startPrice <= 0 || p.endPrice <= 0) throw new Error('invalid position')
    const pnl = round(p.qty * (p.endPrice - p.startPrice), 2)
    const startValue = round(p.qty * p.startPrice, 2)
    positionPnl[p.code] = round((positionPnl[p.code] ?? 0) + pnl, 2)
    positionStartValue[p.code] = round((positionStartValue[p.code] ?? 0) + startValue, 2)
    sectorPnl[p.sector || '未分类'] = round((sectorPnl[p.sector || '未分类'] ?? 0) + pnl, 2)
    sectorStartValue[p.sector || '未分类'] = round((sectorStartValue[p.sector || '未分类'] ?? 0) + startValue, 2)
  }
  const grossPnl = round(Object.values(positionPnl).reduce((a, b) => a + b, 0), 2)
  const explainedNetPnl = round(grossPnl - input.fees - input.slippage, 2)
  const actualNetPnl = round(input.actualEndEquity - input.startEquity - input.netCashFlow, 2)
  const netReturn = round(actualNetPnl / input.startEquity, 6)
  const positionWeights = Object.fromEntries(Object.entries(positionStartValue).map(([code, value]) => [code, round(value / input.startEquity, 6)]))
  const sectorExposure = Object.fromEntries(Object.entries(sectorStartValue).map(([sector, value]) => [sector, round(value / input.startEquity, 6)]))
  const investedCapital = round(Object.values(positionStartValue).reduce((a, b) => a + b, 0), 2)
  if (investedCapital > input.startEquity + 0.01) throw new Error('positions exceed start equity; leveraged attribution requires an explicit model')
  const positionPnlSum = round(Object.values(positionPnl).reduce((sum, value) => sum + value, 0), 2)
  const residualPnl = round(actualNetPnl - explainedNetPnl, 2)
  return { grossPnl, fees: input.fees, slippage: input.slippage, netCashFlow: input.netCashFlow,
    explainedNetPnl, actualNetPnl, netPnl: actualNetPnl, netReturn, benchmarkReturn: input.benchmarkReturn,
    excessReturn: round(netReturn - input.benchmarkReturn, 6), positionPnl, sectorPnl, positionWeights, sectorExposure,
    investedCapital, cashWeight: round(Math.max(0, 1 - investedCapital / input.startEquity), 6),
    topPositionWeight: round(Math.max(0, ...Object.values(positionWeights)), 6),
    reconciliation: { positionPnlSum, feeEffect: input.fees === 0 ? 0 : -input.fees,
      slippageEffect: input.slippage === 0 ? 0 : -input.slippage, residualPnl,
      status: Math.abs(residualPnl) <= 0.01 ? 'balanced' : 'degraded' } }
}

export interface OutcomeInput {
  action: 'buy' | 'add' | 'sell' | 'reduce'
  decisionPrice: number; benchmarkPrice: number; observedPrice: number; observedBenchmark: number
  high: number; low: number
}

export function evaluateDecisionOutcome(input: OutcomeInput) {
  if (Object.entries(input).filter(([key]) => key !== 'action').some(([, value]) => !Number.isFinite(value) || Number(value) <= 0)) throw new Error('invalid outcome input')
  if (input.high < input.low || input.observedPrice < input.low || input.observedPrice > input.high) throw new Error('inconsistent outcome price range')
  const direction = input.action === 'buy' || input.action === 'add' ? 1 : -1
  const absoluteReturn = direction * (input.observedPrice / input.decisionPrice - 1)
  const benchmarkReturn = direction * (input.observedBenchmark / input.benchmarkPrice - 1)
  const favorable = direction === 1 ? input.high / input.decisionPrice - 1 : 1 - input.low / input.decisionPrice
  const adverse = direction === 1 ? input.low / input.decisionPrice - 1 : 1 - input.high / input.decisionPrice
  const excessReturn = absoluteReturn - benchmarkReturn
  return { absoluteReturn: round(absoluteReturn, 6), benchmarkReturn: round(benchmarkReturn, 6),
    excessReturn: round(excessReturn, 6), mfe: round(favorable, 6), mae: round(adverse, 6), hit: excessReturn > 0 }
}

export interface SessionAuditInput {
  date: string; expected: string[]; observed: Array<{ boundary: string; driftSeconds: number }>
  quoteCoverage: number; overlapSuppressed: number
}

export function evaluateMarketSession(input: SessionAuditInput) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !Number.isFinite(input.quoteCoverage) || input.quoteCoverage < 0 || input.quoteCoverage > 1
    || !Number.isInteger(input.overlapSuppressed) || input.overlapSuppressed < 0
    || input.expected.some(value => !/^\d{2}:\d{2}$/.test(value))
    || input.observed.some(value => !/^\d{2}:\d{2}$/.test(value.boundary) || !Number.isFinite(value.driftSeconds))) {
    throw new Error('invalid session audit input')
  }
  const observed = new Map(input.observed.map(x => [x.boundary, x.driftSeconds]))
  const missingBoundaries = input.expected.filter(x => !observed.has(x))
  const maxDriftSeconds = Math.max(0, ...input.observed.map(x => Math.abs(x.driftSeconds)))
  const pass = missingBoundaries.length === 0 && maxDriftSeconds <= 10
    && input.quoteCoverage >= 0.95 && input.overlapSuppressed === 0
  return { date: input.date, pass, missingBoundaries, maxDriftSeconds,
    quoteCoverage: input.quoteCoverage, overlapSuppressed: input.overlapSuppressed }
}

function round(value: number, digits: number): number {
  return Number(value.toFixed(digits))
}

function explicitTimestamp(value: string): boolean {
  return /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value))
}

interface IntelligenceState {
  version: 1
  quoteChecks: Array<Record<string, unknown>>
  events: MarketEvent[]
  valuations: Array<Record<string, unknown>>
  attributions: Array<Record<string, unknown>>
  outcomes: Array<Record<string, unknown>>
  completedOutcomeKeys: string[]
  outcomeStats: { totalCount: number; hitCount: number; excessReturnSum: number }
  sessionAudits: Array<Record<string, unknown>>
}

const EMPTY_STATE = (): IntelligenceState => ({
  version: 1, quoteChecks: [], events: [], valuations: [], attributions: [], outcomes: [],
  completedOutcomeKeys: [], outcomeStats: { totalCount: 0, hitCount: 0, excessReturnSum: 0 }, sessionAudits: [],
})

const OUTCOME_DETAIL_LIMIT = 200
const OUTCOME_IDENTITY_LIMIT = 10_000

export class ResearchIntelligenceStore {
  private readonly path: string

  constructor(dataDir: string) {
    const memoryDir = join(dataDir, 'memory')
    mkdirSync(memoryDir, { recursive: true })
    this.path = join(memoryDir, 'research-intelligence.json')
  }

  snapshot(): IntelligenceState {
    return structuredClone(this.load())
  }

  ingestEvents(events: RawMarketEvent[], positionCodes: string[]): MarketEvent[] {
    const state = this.load()
    state.events = mergeMarketEvents(state.events, events, positionCodes).slice(0, 200)
    this.save(state)
    return structuredClone(state.events)
  }

  saveQuoteCheck(value: Record<string, unknown>): void { this.appendUnique('quoteChecks', value, ['code', 'checkedAt']) }
  saveValuation(value: Record<string, unknown>): void { this.appendUnique('valuations', value, ['code', 'asOf']) }
  saveValuations(values: Array<Record<string, unknown>>): number {
    if (!Array.isArray(values)) throw new Error('valuations batch must be an array')
    if (values.length === 0) return 0
    const state = this.load()
    const identities = new Set(state.valuations.map(item => `${item.code}|${item.asOf}`))
    let added = 0
    for (const value of values.slice(0, 500)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || typeof value.code !== 'string' || !value.code.trim() || typeof value.asOf !== 'string' || !value.asOf.trim()) {
        throw new Error('valuations entry is missing identity')
      }
      const identity = `${value.code}|${value.asOf}`
      if (identities.has(identity)) continue
      state.valuations.push(structuredClone(value)); identities.add(identity); added++
    }
    if (added > 0) { state.valuations = state.valuations.slice(-200); this.save(state) }
    return added
  }
  saveAttribution(value: Record<string, unknown>): void { this.appendUnique('attributions', value, ['asOf']) }
  saveOutcome(value: Record<string, unknown>): void {
    const decisionId = typeof value.decisionId === 'string' ? value.decisionId.trim() : ''
    const horizonDays = value.horizonDays
    const decisionAt = Date.parse(String(value.decisionAt ?? ''))
    const dueAt = Date.parse(String(value.dueAt ?? ''))
    const observedAt = Date.parse(String(value.observedAt ?? ''))
    if (!decisionId || !Number.isInteger(horizonDays) || Number(horizonDays) <= 0
      || ![value.decisionAt, value.dueAt, value.observedAt].every(item => typeof item === 'string' && explicitTimestamp(item))
      || !Number.isFinite(decisionAt) || !Number.isFinite(dueAt) || !Number.isFinite(observedAt)
      || Math.abs(dueAt - decisionAt - Number(horizonDays) * 86_400_000) > 60_000
      || observedAt < dueAt || typeof value.hit !== 'boolean'
      || typeof value.excessReturn !== 'number' || !Number.isFinite(value.excessReturn)) {
      throw new Error('invalid outcome identity, metrics, or observation window')
    }
    const state = this.load()
    const identity = `${decisionId}|${horizonDays}`
    if (state.completedOutcomeKeys.includes(identity)) {
      throw new Error('outcome already recorded for decision and horizon')
    }
    if (state.completedOutcomeKeys.length >= OUTCOME_IDENTITY_LIMIT) {
      throw new Error(`outcome identity capacity ${OUTCOME_IDENTITY_LIMIT} reached; archive is required`)
    }
    state.outcomes.push(structuredClone(value)); state.outcomes = state.outcomes.slice(-OUTCOME_DETAIL_LIMIT)
    state.completedOutcomeKeys.push(identity)
    state.outcomeStats.totalCount++
    if (value.hit) state.outcomeStats.hitCount++
    state.outcomeStats.excessReturnSum = round(state.outcomeStats.excessReturnSum + value.excessReturn, 8)
    this.save(state)
  }
  saveSessionAudit(value: Record<string, unknown>): void {
    const state = this.load()
    const date = typeof value.date === 'string' ? value.date : null
    if (date) state.sessionAudits = state.sessionAudits.filter(item => item.date !== date)
    state.sessionAudits.push(structuredClone(value))
    state.sessionAudits = state.sessionAudits.slice(-200)
    this.save(state)
  }

  private append(key: 'quoteChecks' | 'valuations' | 'attributions' | 'outcomes' | 'sessionAudits', value: Record<string, unknown>): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${key} entry must be an object`)
    const state = this.load()
    state[key].push(structuredClone(value))
    state[key] = state[key].slice(-200)
    this.save(state)
  }

  private appendUnique(key: 'quoteChecks' | 'valuations' | 'attributions', value: Record<string, unknown>, identityFields: string[]): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${key} entry must be an object`)
    if (identityFields.some(field => typeof value[field] !== 'string' || !String(value[field]).trim())) {
      throw new Error(`${key} entry is missing identity`)
    }
    const state = this.load()
    if (state[key].some(item => identityFields.every(field => item[field] === value[field]))) throw new Error(`${key} entry already recorded`)
    state[key].push(structuredClone(value)); state[key] = state[key].slice(-200); this.save(state)
  }

  private load(): IntelligenceState {
    if (!existsSync(this.path)) return EMPTY_STATE()
    let raw: unknown
    try { raw = JSON.parse(readFileSync(this.path, 'utf8')) } catch (error) {
      throw new Error(`research intelligence state is corrupt: ${(error as Error).message}`, { cause: error })
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('research intelligence state is corrupt: root')
    const state = raw as Partial<IntelligenceState>
    if (state.version !== 1 || !Array.isArray(state.quoteChecks) || !Array.isArray(state.events) || !Array.isArray(state.valuations)
      || !Array.isArray(state.attributions) || !Array.isArray(state.outcomes) || !Array.isArray(state.sessionAudits)) {
      throw new Error('research intelligence state is corrupt: schema')
    }
    const derivedKeys = state.outcomes.flatMap(item => typeof item.decisionId === 'string' && Number.isInteger(item.horizonDays)
      ? [`${item.decisionId}|${item.horizonDays}`] : [])
    const completedOutcomeKeys = state.completedOutcomeKeys ?? derivedKeys
    const outcomeStats = state.outcomeStats ?? {
      totalCount: derivedKeys.length,
      hitCount: state.outcomes.filter(item => item.hit === true).length,
      excessReturnSum: round(state.outcomes.reduce((sum, item) => sum
        + (typeof item.excessReturn === 'number' && Number.isFinite(item.excessReturn) ? item.excessReturn : 0), 0), 8),
    }
    if (!Array.isArray(completedOutcomeKeys) || completedOutcomeKeys.length > OUTCOME_IDENTITY_LIMIT
      || completedOutcomeKeys.some(key => typeof key !== 'string' || !/^.+\|\d+$/.test(key))
      || new Set(completedOutcomeKeys).size !== completedOutcomeKeys.length
      || !outcomeStats || !Number.isInteger(outcomeStats.totalCount) || outcomeStats.totalCount < 0
      || !Number.isInteger(outcomeStats.hitCount) || outcomeStats.hitCount < 0 || outcomeStats.hitCount > outcomeStats.totalCount
      || !Number.isFinite(outcomeStats.excessReturnSum) || outcomeStats.totalCount !== completedOutcomeKeys.length) {
      throw new Error('research intelligence state is corrupt: outcome ledger')
    }
    return { ...(state as IntelligenceState), completedOutcomeKeys, outcomeStats }
  }

  private save(state: IntelligenceState): void {
    atomicWriteJsonSync(this.path, state, 2)
  }
}
