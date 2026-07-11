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
    if (abandoned) this.store.saveSessionAudit({ ...abandoned, status: 'failed', pass: false,
      finalizedAt: now.toISOString(), finalizationReason: 'next trading day started before close boundary was observed' })
    const previous = snapshot.sessionAudits.findLast(item => item.date === local.date)
    const observed = Array.isArray(previous?.observed) ? previous.observed.filter(validObservation) as Array<{ boundary: string; driftSeconds: number }> : []
    for (const boundary of expected) {
      const [hour, minute] = boundary.split(':').map(Number)
      const driftSeconds = (local.hour * 3600 + local.minute * 60 + local.second) - (hour! * 3600 + minute! * 60)
      if (Math.abs(driftSeconds) <= 90 && !observed.some(item => item.boundary === boundary)) observed.push({ boundary, driftSeconds })
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

function validObservation(value: unknown): boolean {
  return !!value && typeof value === 'object' && typeof (value as { boundary?: unknown }).boundary === 'string'
    && Number.isFinite((value as { driftSeconds?: unknown }).driftSeconds)
}

function localParts(now: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now)
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? '0'
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')), minute: Number(get('minute')), second: Number(get('second')) }
}
