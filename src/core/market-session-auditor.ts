import { evaluateMarketSession, type ResearchIntelligenceStore } from '../finance/research-intelligence.js'

const FULL_DAY_EXPECTED = ['09:15', '09:30', '11:30', '13:00', '14:57', '15:00']
const HALF_DAY_EXPECTED = ['09:15', '09:30', '11:30']

export class MarketSessionAuditor {
  constructor(private readonly store: ResearchIntelligenceStore) {}

  record(now: Date, quoteCoverage: number, overlapSuppressed: number, halfDay = false): void {
    const local = localParts(now)
    const expected = halfDay ? HALF_DAY_EXPECTED : FULL_DAY_EXPECTED
    const snapshot = this.store.snapshot()
    const abandoned = snapshot.sessionAudits.findLast(item => item.date !== local.date && item.status === 'collecting')
    if (abandoned) {
      const abandonedExpected = storedExpected(abandoned.expected)
      const abandonedObserved = sanitizeObservations(abandoned.observed, abandonedExpected)
      const abandonedCoverage = ratio(abandoned.quoteCoverage) ? abandoned.quoteCoverage : 0
      const abandonedOverlap = nonNegativeInteger(abandoned.overlapSuppressed) ? abandoned.overlapSuppressed : 0
      const migrated = evaluateMarketSession({ date: String(abandoned.date), expected: abandonedExpected,
        observed: abandonedObserved, quoteCoverage: abandonedCoverage, overlapSuppressed: abandonedOverlap })
      this.store.saveSessionAudit({ ...abandoned, ...migrated, status: 'failed', pass: false,
        expected: abandonedExpected, observed: abandonedObserved, finalizedAt: now.toISOString(),
        finalizationReason: 'next trading day started before close boundary was observed' })
    }
    const previous = snapshot.sessionAudits.findLast(item => item.date === local.date)
    const observed = sanitizeObservations(previous?.observed, expected)
    for (const boundary of expected) {
      const [hour, minute] = boundary.split(':').map(Number)
      const driftSeconds = (local.hour * 3600 + local.minute * 60 + local.second) - (hour! * 3600 + minute! * 60)
      // cadence tick 可以晚到后归属于刚过去的边界，但绝不能提前占用未来边界。
      // 否则 09:29:06 会把 09:30 记成 -54s，真正 09:30 tick 随后被去重丢弃。
      if (driftSeconds >= 0 && driftSeconds <= 90 && !observed.some(item => item.boundary === boundary)) observed.push({ boundary, driftSeconds })
    }
    const coverageSample = Number.isFinite(quoteCoverage) ? Math.max(0, Math.min(1, quoteCoverage)) : 0
    const coverageSamples = Array.isArray(previous?.coverageSamples)
      ? previous.coverageSamples.filter(Number.isFinite).map(Number).slice(-999) : []
    coverageSamples.push(coverageSample)
    const coverage = coverageSamples.reduce((sum, value) => sum + value, 0) / coverageSamples.length
    const previousDay = snapshot.sessionAudits.findLast(item => typeof item.lastOverlapTotal === 'number' && item.date !== local.date)
    const overlapBaseline = typeof previous?.overlapBaseline === 'number' ? previous.overlapBaseline
      : typeof previousDay?.lastOverlapTotal === 'number' ? previousDay.lastOverlapTotal : overlapSuppressed
    const dailyOverlap = Math.max(0, overlapSuppressed - overlapBaseline)
    const result = evaluateMarketSession({ date: local.date, expected, observed,
      quoteCoverage: coverage, overlapSuppressed: dailyOverlap })
    const closeBoundary = halfDay ? '11:30' : '15:00'
    const closeSeconds = halfDay ? 11 * 3600 + 30 * 60 : 15 * 3600
    const finalized = observed.some(item => item.boundary === closeBoundary)
      || local.hour * 3600 + local.minute * 60 + local.second >= closeSeconds
    this.store.saveSessionAudit({ ...result, status: finalized ? result.pass ? 'passed' : 'failed' : 'collecting',
      ...(finalized ? { finalizedAt: now.toISOString() } : {}), expected, observed, coverageSamples,
      overlapBaseline, lastOverlapTotal: overlapSuppressed, updatedAt: now.toISOString() })
  }
}

function sanitizeObservations(value: unknown, expected: string[]): Array<{ boundary: string; driftSeconds: number }> {
  if (!Array.isArray(value)) return []
  const observed: Array<{ boundary: string; driftSeconds: number }> = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const boundary = (item as { boundary?: unknown }).boundary
    const driftSeconds = (item as { driftSeconds?: unknown }).driftSeconds
    if (typeof boundary !== 'string' || !expected.includes(boundary) || typeof driftSeconds !== 'number'
      || !Number.isFinite(driftSeconds) || driftSeconds < 0 || driftSeconds > 90
      || observed.some(entry => entry.boundary === boundary)) continue
    observed.push({ boundary, driftSeconds })
  }
  return observed
}

function storedExpected(value: unknown): string[] {
  if (!Array.isArray(value)) return FULL_DAY_EXPECTED
  if (sameBoundaries(value, HALF_DAY_EXPECTED)) return HALF_DAY_EXPECTED
  if (sameBoundaries(value, FULL_DAY_EXPECTED)) return FULL_DAY_EXPECTED
  return FULL_DAY_EXPECTED
}

function sameBoundaries(value: unknown[], canonical: string[]): boolean {
  return value.length === canonical.length && value.every((item, index) => item === canonical[index])
}

function ratio(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function localParts(now: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now)
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? '0'
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')), minute: Number(get('minute')), second: Number(get('second')) }
}
