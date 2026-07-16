import type { RawMarketEvent } from '../finance/research-intelligence.js'

const ORG_MAP_URL = 'https://www.cninfo.com.cn/new/data/szse_stock.json'
const ANNOUNCEMENT_URL = 'https://www.cninfo.com.cn/new/hisAnnouncement/query'
const STATIC_URL = 'https://static.cninfo.com.cn/'
const MAX_CODES = 20
const PAGE_SIZE = 30
const MAX_PAGES = 4
const DATE = /^\d{4}-\d{2}-\d{2}$/

export class CninfoAnnouncementClient {
  private orgIdsPromise: Promise<Map<string, string>> | null = null

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async fetch(codes: string[], from: string, to: string): Promise<RawMarketEvent[]> {
    const uniqueCodes = [...new Set(codes)]
    if (!DATE.test(from) || !DATE.test(to) || from > to) throw new Error('invalid cninfo announcement date range')
    if (uniqueCodes.length > MAX_CODES || uniqueCodes.some(code => !/^\d{6}$/.test(code))) {
      throw new Error(`invalid cninfo announcement codes; maximum ${MAX_CODES}`)
    }
    if (uniqueCodes.length === 0) return []
    const orgIds = await this.orgIds()
    const events: RawMarketEvent[] = []
    // 巨潮是公告官方源，按持仓串行查询，避免将单用户组合变成并发抓取器。
    for (const code of uniqueCodes) {
      const orgId = orgIds.get(code)
      if (!orgId) throw new Error(`cninfo orgId unavailable for ${code}`)
      events.push(...await this.fetchCode(code, orgId, from, to))
    }
    return events
  }

  private async orgIds(): Promise<Map<string, string>> {
    if (!this.orgIdsPromise) {
      this.orgIdsPromise = this.loadOrgIds().catch(error => {
        this.orgIdsPromise = null
        throw error
      })
    }
    return this.orgIdsPromise
  }

  private async loadOrgIds(): Promise<Map<string, string>> {
    const response = await this.request(ORG_MAP_URL, { headers: requestHeaders() })
    const body = await response.json() as { stockList?: unknown }
    if (!Array.isArray(body.stockList)) throw new Error('invalid cninfo orgId mapping')
    const result = new Map<string, string>()
    for (const item of body.stockList) {
      if (!item || typeof item !== 'object') continue
      const { code, orgId } = item as { code?: unknown; orgId?: unknown }
      if (typeof code === 'string' && /^\d{6}$/.test(code) && typeof orgId === 'string' && orgId.trim()) {
        result.set(code, orgId.trim())
      }
    }
    return result
  }

  private async fetchCode(code: string, orgId: string, from: string, to: string): Promise<RawMarketEvent[]> {
    const events: RawMarketEvent[] = []
    let pages = 1
    let expectedTotal: number | null = null
    let received = 0
    for (let page = 1; page <= pages; page++) {
      const form = new URLSearchParams({ stock: `${code},${orgId}`, tabName: 'fulltext', pageSize: String(PAGE_SIZE),
        pageNum: String(page), column: '', category: '', plate: '', seDate: `${from}~${to}`, searchkey: '', secid: '',
        sortName: '', sortType: '', isHLtitle: 'true' })
      const response = await this.request(ANNOUNCEMENT_URL, { method: 'POST', headers: {
        ...requestHeaders(), 'Content-Type': 'application/x-www-form-urlencoded',
        Referer: 'https://www.cninfo.com.cn/new/disclosure', Origin: 'https://www.cninfo.com.cn',
      }, body: form })
      const body = await response.json() as { announcements?: unknown; totalAnnouncement?: unknown }
      if (!Number.isInteger(body.totalAnnouncement) || (body.totalAnnouncement as number) < 0) {
        throw new Error(`invalid announcement total for ${code}`)
      }
      const total = body.totalAnnouncement as number
      if (expectedTotal === null) {
        expectedTotal = total
        pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
        if (pages > MAX_PAGES) throw new Error(`cninfo announcement capacity exceeded for ${code}`)
      } else if (total !== expectedTotal) throw new Error(`cninfo announcement total changed for ${code}`)
      if (total === 0) {
        if (body.announcements !== null && !(Array.isArray(body.announcements) && body.announcements.length === 0)) {
          throw new Error(`incomplete announcements for ${code}`)
        }
        return []
      }
      if (!Array.isArray(body.announcements)) throw new Error(`incomplete announcements for ${code}`)
      const expectedPageCount = page < pages ? PAGE_SIZE : total - PAGE_SIZE * (page - 1)
      if (body.announcements.length !== expectedPageCount) throw new Error(`incomplete announcements for ${code} page ${page}`)
      for (const item of body.announcements) events.push(normalizeAnnouncement(item, code))
      received += body.announcements.length
    }
    if (expectedTotal === null || received !== expectedTotal) throw new Error(`incomplete announcements for ${code}`)
    return events
  }

  private async request(input: string, init: RequestInit): Promise<Response> {
    const response = await this.fetchImpl(input, { ...init, signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error(`cninfo HTTP ${response.status}`)
    return response
  }
}

function normalizeAnnouncement(value: unknown, code: string): RawMarketEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid announcement row for ${code}`)
  const item = value as Record<string, unknown>
  const title = typeof item.announcementTitle === 'string' ? plainText(item.announcementTitle) : ''
  const time = typeof item.announcementTime === 'number' ? item.announcementTime : Number.NaN
  if (!title || !Number.isFinite(time)
    || (item.adjunctUrl != null && typeof item.adjunctUrl !== 'string')
    || (item.announcementTypeName != null && typeof item.announcementTypeName !== 'string')) {
    throw new Error(`invalid announcement row for ${code}`)
  }
  const date = new Date(time)
  if (!Number.isFinite(date.getTime())) throw new Error(`invalid announcement row for ${code}`)
  const adjunct = typeof item.adjunctUrl === 'string' ? item.adjunctUrl.replace(/^\/+/, '') : ''
  const type = typeof item.announcementTypeName === 'string' ? plainText(item.announcementTypeName) : ''
  return { source: 'cninfo', title, publishedAt: date.toISOString(),
    ...(adjunct ? { url: STATIC_URL + adjunct } : {}), ...(type ? { content: type } : {}), codeHints: [code] }
}

function plainText(value: string): string {
  return value.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/\s+/g, ' ').trim()
}

function requestHeaders(): Record<string, string> {
  return { 'User-Agent': 'Mozilla/5.0 (compatible; ShionResearch/0.4; +self-hosted)' }
}
