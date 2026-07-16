import { mergeMarketEvents, type MarketEvent, type RawMarketEvent, type ResearchIntelligenceStore } from '../finance/research-intelligence.js'

export type EventFetcher = (codes: string[], from: string, to: string) => Promise<RawMarketEvent[]>

export interface MarketEventMonitorDeps {
  store: ResearchIntelligenceStore
  getPositionCodes: () => string[]
  fetchEvents: EventFetcher
  fallbackFetchEvents?: EventFetcher
  deliverToUser: (text: string) => Promise<void>
  intervalMs?: number
  now?: () => Date
}

export class MarketEventMonitor {
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private generation = 0
  private inFlight = false
  private health = { status: 'idle', last_check_at: null as string | null, last_success_at: null as string | null,
    event_count: 0, new_alert_count: 0, last_error: null as string | null,
    last_source: null as 'primary' | 'fallback' | null, skipped_reason: null as 'quiet_window' | null,
    next_check_at: null as string | null }

  constructor(private readonly deps: MarketEventMonitorDeps) {}

  start(): void {
    if (this.running) return
    this.running = true
    void this.runAndSchedule(++this.generation)
  }

  stop(): void {
    this.running = false
    this.generation++
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.health = { ...this.health, next_check_at: null }
  }
  getHealthSnapshot() { return { ...this.health } }

  async tick(): Promise<void> {
    if (this.inFlight) return
    const now = this.deps.now?.() ?? new Date()
    const nowIso = now.toISOString()
    if (!inEventWindow(now)) {
      this.health = { ...this.health, status: 'idle', skipped_reason: 'quiet_window',
        next_check_at: nextEventCheckAt(now, this.deps.intervalMs ?? 15 * 60_000).toISOString() }
      return
    }
    this.inFlight = true
    try {
      const codes = [...new Set(this.deps.getPositionCodes().filter(code => /^\d{6}$/.test(code)))].sort()
      if (codes.length === 0) {
        this.health = { ...this.health, status: 'idle', last_check_at: nowIso, event_count: 0,
          new_alert_count: 0, last_error: null, skipped_reason: null, last_source: null }
        return
      }
      const to = beijingDate(now)
      const from = beijingDate(new Date(now.getTime() - 24 * 60 * 60_000))
      let fetched: RawMarketEvent[]
      let source: 'primary' | 'fallback' = 'primary'
      let primaryError: Error | null = null
      try { fetched = await this.deps.fetchEvents(codes, from, to) } catch (error) {
        primaryError = error as Error
        if (!this.deps.fallbackFetchEvents) throw error
        source = 'fallback'
        try { fetched = await this.deps.fallbackFetchEvents(codes, from, to) } catch (fallbackError) {
          throw new Error(`primary source failed: ${primaryError.message}; fallback source failed: ${(fallbackError as Error).message}`,
            { cause: fallbackError })
        }
      }
      let events = this.deps.store.snapshot().events
      let alertCount = 0
      for (const raw of fetched) {
        const beforeById = new Map(events.map(event => [event.id, event]))
        const mergedEvents = mergeMarketEvents(events, [raw], codes)
        const candidate = mergedEvents.find(event => {
          const before = beforeById.get(event.id)
          return !before || (!before.requiresAlert && event.requiresAlert)
        })
        if (candidate?.requiresAlert) {
          await this.deps.deliverToUser(eventAlertText(candidate))
          alertCount++
        }
        if (!sameEventState(events, mergedEvents)) events = this.deps.store.ingestEvents([raw], codes)
      }
      this.health = { ...this.health, status: source === 'fallback' ? 'degraded' : 'healthy',
        last_check_at: nowIso, last_success_at: nowIso, event_count: events.length, new_alert_count: alertCount,
        last_error: primaryError?.message ?? null, last_source: source, skipped_reason: null }
    } catch (error) {
      this.health = { ...this.health, status: 'degraded', last_check_at: nowIso, new_alert_count: 0, last_error: (error as Error).message }
    } finally { this.inFlight = false }
  }

  private async runAndSchedule(generation: number): Promise<void> {
    if (!this.running || generation !== this.generation) return
    await this.tick()
    if (!this.running || generation !== this.generation) return
    const now = this.deps.now?.() ?? new Date()
    const next = nextEventCheckAt(now, this.deps.intervalMs ?? 15 * 60_000)
    this.health = { ...this.health, next_check_at: next.toISOString() }
    this.timer = setTimeout(() => { void this.runAndSchedule(generation) }, Math.max(1_000, next.getTime() - now.getTime()))
    this.timer.unref?.()
  }
}

function sameEventState(left: MarketEvent[], right: MarketEvent[]): boolean {
  return left.length === right.length && left.every((event, index) => {
    const other = right[index]
    return other !== undefined && event.id === other.id && event.source === other.source && event.title === other.title
      && event.publishedAt === other.publishedAt && event.url === other.url && event.content === other.content
      && event.severity === other.severity && event.requiresAlert === other.requiresAlert
      && event.relatedCodes.length === other.relatedCodes.length
      && event.relatedCodes.every((code, codeIndex) => code === other.relatedCodes[codeIndex])
  })
}

export function nextEventCheckAt(now: Date, intervalMs: number): Date {
  const local = localParts(now)
  if (local.minutes < 7 * 60) return beijingTime(local.year, local.month, local.day, 7, 0)
  if (local.minutes >= 23 * 60 + 30) return beijingTime(local.year, local.month, local.day + 1, 7, 0)
  const candidate = new Date(now.getTime() + intervalMs)
  const candidateLocal = localParts(candidate)
  if (candidateLocal.year !== local.year || candidateLocal.month !== local.month || candidateLocal.day !== local.day
    || candidateLocal.minutes >= 23 * 60 + 30) return beijingTime(local.year, local.month, local.day + 1, 7, 0)
  return candidate
}

function inEventWindow(now: Date): boolean {
  const minutes = localParts(now).minutes
  return minutes >= 7 * 60 && minutes < 23 * 60 + 30
}

function localParts(now: Date): { year: number; month: number; day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now)
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(part => part.type === type)?.value ?? 0)
  return { year: get('year'), month: get('month'), day: get('day'), minutes: get('hour') * 60 + get('minute') }
}

function beijingTime(year: number, month: number, day: number, hour: number, minute: number): Date {
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute))
}

export function parseIfindNoticeEvents(output: string): RawMarketEvent[] {
  let outer: { code?: number; msg?: string; data?: { data?: string } | string }
  try { outer = JSON.parse(output) } catch (error) { throw new Error(`invalid iFind notice JSON: ${(error as Error).message}`, { cause: error }) }
  if (outer.code !== 1) throw new Error(`iFind notice failed: ${outer.msg ?? `code ${outer.code ?? 'missing'}`}`)
  const nested = typeof outer.data === 'string' ? outer.data : outer.data?.data
  if (typeof nested !== 'string') throw new Error('invalid iFind notice payload: missing data')
  let rows: unknown
  try { rows = JSON.parse(nested) } catch (error) { throw new Error(`invalid iFind notice data: ${(error as Error).message}`, { cause: error }) }
  if (!Array.isArray(rows)) throw new Error('invalid iFind notice payload: data is not an array')
  return rows.flatMap(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return []
    const item = row as Record<string, unknown>
    const title = typeof item['公告标题'] === 'string' ? item['公告标题'].trim() : ''
    const date = typeof item['日期'] === 'string' ? item['日期'] : ''
    if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return []
    return [{ source: 'ifind-notice', title, publishedAt: new Date(`${date}T00:00:00+08:00`).toISOString(),
      content: typeof item['公告片段内容'] === 'string' ? item['公告片段内容'] : undefined }]
  })
}

function eventAlertText(event: { severity: string; title: string; relatedCodes: string[]; publishedAt: string }): string {
  return `[投研事件·${event.severity}] ${event.title}\n关联持仓: ${event.relatedCodes.join(', ')} · ${event.publishedAt.slice(0, 10)}\n这是研究提醒，不代表交易指令。`
}

function beijingDate(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}
