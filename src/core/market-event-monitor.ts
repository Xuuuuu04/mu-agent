import { mergeMarketEvents, type RawMarketEvent, type ResearchIntelligenceStore } from '../finance/research-intelligence.js'

export type EventFetcher = (codes: string[], from: string, to: string) => Promise<RawMarketEvent[]>

export interface MarketEventMonitorDeps {
  store: ResearchIntelligenceStore
  getPositionCodes: () => string[]
  fetchEvents: EventFetcher
  deliverToUser: (text: string) => Promise<void>
  intervalMs?: number
  now?: () => Date
}

export class MarketEventMonitor {
  private timer: ReturnType<typeof setInterval> | null = null
  private inFlight = false
  private health = { status: 'idle', last_check_at: null as string | null, last_success_at: null as string | null,
    event_count: 0, new_alert_count: 0, last_error: null as string | null }

  constructor(private readonly deps: MarketEventMonitorDeps) {}

  start(): void {
    if (this.timer) return
    void this.tick()
    this.timer = setInterval(() => { void this.tick() }, this.deps.intervalMs ?? 15 * 60_000)
    this.timer.unref?.()
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null }
  getHealthSnapshot() { return { ...this.health } }

  async tick(): Promise<void> {
    if (this.inFlight) return
    this.inFlight = true
    const now = this.deps.now?.() ?? new Date()
    const nowIso = now.toISOString()
    try {
      const codes = [...new Set(this.deps.getPositionCodes().filter(code => /^\d{6}$/.test(code)))].sort()
      if (codes.length === 0) {
        this.health = { ...this.health, status: 'idle', last_check_at: nowIso, event_count: 0, new_alert_count: 0, last_error: null }
        return
      }
      const to = beijingDate(now)
      const from = beijingDate(new Date(now.getTime() - 24 * 60 * 60_000))
      const fetched = await this.deps.fetchEvents(codes, from, to)
      let events = this.deps.store.snapshot().events
      let alertCount = 0
      for (const raw of fetched) {
        const beforeById = new Map(events.map(event => [event.id, event]))
        const candidate = mergeMarketEvents(events, [raw], codes).find(event => {
          const before = beforeById.get(event.id)
          return !before || (!before.requiresAlert && event.requiresAlert)
        })
        if (!candidate) continue
        if (candidate.requiresAlert) {
          await this.deps.deliverToUser(eventAlertText(candidate))
          alertCount++
        }
        events = this.deps.store.ingestEvents([raw], codes)
      }
      this.health = { status: 'healthy', last_check_at: nowIso, last_success_at: nowIso,
        event_count: events.length, new_alert_count: alertCount, last_error: null }
    } catch (error) {
      this.health = { ...this.health, status: 'degraded', last_check_at: nowIso, new_alert_count: 0, last_error: (error as Error).message }
    } finally { this.inFlight = false }
  }
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
