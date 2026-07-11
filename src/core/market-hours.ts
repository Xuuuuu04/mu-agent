// A 股交易时段纯函数。UTC+8 硬编码 —— 不读系统时区,部署到任何时区都按北京时间判时段。
// 这是 R1/R2 review 抓的时区撕裂根因:marketPhase 按北京时间算,而旧 clampWake.hour 走系统 getHours,
// 非 CST 服务器上盘中 morning 会被判成 night,市场下限静默失效。这里统一用 UTC 偏移取北京时间。

import { readFileSync } from 'node:fs'

// 时段顺序:pre_market → call_auction → morning → lunch → afternoon → call_close → post_market
// 非交易日 / 收盘后非交易日语义统一返 'closed',clampWake 据此决定是否叠加更紧的市场下限。
export type MarketPhase =
  | 'pre_market'    // 交易日 [00:00, 09:15)
  | 'call_auction'  // 开盘集合竞价 [09:15, 09:30)
  | 'morning'       // 上午连续竞价 [09:30, 11:30)
  | 'lunch'         // 午休 [11:30, 13:00)
  | 'afternoon'     // 下午连续竞价 [13:00, 14:57)
  | 'call_close'    // 收盘集合竞价 [14:57, 15:00)
  | 'post_market'   // 盘后 [15:00, 24:00)
  | 'closed'        // 非交易日,或半日市午后

export interface TradeCalendar {
  version?: number
  updated?: string
  valid_through: string // YYYY-MM-DD;过期则视为 stale → 降级
  holidays: string[] // YYYY-MM-DD,休市日(含周末外的法定假日)
  half_days: string[] // YYYY-MM-DD,半日市(仅上午交易,午后 closed)
  extra_trade_days?: string[] // 预留:A 股不跟调休补班,当前不消费
}

const BEIJING_OFFSET_MS = 8 * 3600 * 1000

// 北京时间的“分钟数”(0-1439)。UTC getters +8h 偏移,再对一天取模。
export function beijingMinutes(date: Date = new Date()): number {
  const shifted = date.getTime() + BEIJING_OFFSET_MS
  const d = new Date(shifted)
  return d.getUTCHours() * 60 + d.getUTCMinutes()
}

// 北京时间的小时(0-23)。clampWake 的 night 判断用它,和 marketPhase 同基准。
export function beijingHour(date: Date = new Date()): number {
  return Math.floor(beijingMinutes(date) / 60)
}

// 北京日期串 YYYY-MM-DD。用 +8h 偏移后的 UTC getters 拼,避免系统时区干扰。
export function beijingDateStr(date: Date = new Date()): string {
  const d = new Date(date.getTime() + BEIJING_OFFSET_MS)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// 北京星期(0=周日 .. 6=周六)。
export function beijingWeekday(date: Date = new Date()): number {
  return new Date(date.getTime() + BEIJING_OFFSET_MS).getUTCDay()
}

// 是否交易日:A 股按自然周 1-5 交易,**不跟调休补班**(extra_trade_days 不消费);休市日不交易。
export function isTradingDay(date: Date = new Date(), cal: TradeCalendar | null = null): boolean {
  const wd = beijingWeekday(date)
  if (wd === 0 || wd === 6) return false // 周末
  if (cal && cal.holidays.includes(beijingDateStr(date))) return false
  return true
}

// 半日市:仅上午交易(09:15-11:30),午后直接 closed。
function isHalfDay(date: Date, cal: TradeCalendar | null): boolean {
  return !!cal && cal.half_days.includes(beijingDateStr(date))
}

// 当前 A 股时段。非交易日一律 'closed';半日市午后一律 'closed'。
export function getMarketPhase(date: Date = new Date(), cal: TradeCalendar | null = null): MarketPhase {
  if (!isTradingDay(date, cal)) return 'closed'
  const mins = beijingMinutes(date)
  const half = isHalfDay(date, cal)
  // 半日市上午照常,午休及之后全 closed
  if (mins < 9 * 60 + 15) return 'pre_market'
  if (mins < 9 * 60 + 30) return 'call_auction'
  if (mins < 11 * 60 + 30) return 'morning'
  if (half) return 'closed'
  if (mins < 13 * 60) return 'lunch'
  if (mins < 14 * 60 + 57) return 'afternoon'
  if (mins < 15 * 60) return 'call_close'
  return 'post_market'
}

// 下一个连续竞价开盘时刻(morning 开盘 09:30 北京 = 01:30 UTC)。
// 今日是交易日且未到 09:30 → 今日 09:30;否则向前扫最多 20 天找下一个交易日(覆盖春节 7-9 天长假)。
export function nextTradeSessionOpen(date: Date = new Date(), cal: TradeCalendar | null = null): Date {
  const startMs = date.getTime()
  // 今日且尚未开盘
  if (isTradingDay(date, cal) && beijingMinutes(date) < 9 * 60 + 30) {
    return beijingMorningOpen(date)
  }
  for (let i = 1; i <= 20; i++) {
    const candidate = new Date(startMs + i * 86400 * 1000)
    if (isTradingDay(candidate, cal)) return beijingMorningOpen(candidate)
  }
  // 20 天内没找到(日历严重缺失)→ 兜底返回 20 天后,交给上层降级
  return beijingMorningOpen(new Date(startMs + 20 * 86400 * 1000))
}

// watchdog 的下一次确定性检查时刻。盘中按阶段频率前进,但绝不跨过阶段边界；
// 盘前/午休/盘后/非交易日直接睡到下一个有价格变化的边界,避免全天固定轮询空转。
export function nextMarketMonitoringAt(
  date: Date = new Date(),
  cal: TradeCalendar | null = null,
  continuousSec = 180,
  auctionSec = 60,
  closeAuctionSec = 30,
): Date {
  const phase = getMarketPhase(date, cal)
  if (phase === 'pre_market') return beijingAt(date, 9 * 60 + 15)
  if (phase === 'lunch') return beijingAt(date, 13 * 60)
  if (phase === 'call_auction') return beforeBoundary(date, auctionSec, beijingAt(date, 9 * 60 + 30))
  if (phase === 'morning') return beforeBoundary(date, continuousSec, beijingAt(date, 11 * 60 + 30))
  if (phase === 'afternoon') return beforeBoundary(date, continuousSec, beijingAt(date, 14 * 60 + 57))
  if (phase === 'call_close') return beforeBoundary(date, closeAuctionSec, beijingAt(date, 15 * 60))

  const startMs = date.getTime()
  for (let i = phase === 'post_market' || isTradingDay(date, cal) ? 1 : 0; i <= 20; i++) {
    const candidate = new Date(startMs + i * 86400 * 1000)
    if (isTradingDay(candidate, cal)) return beijingAt(candidate, 9 * 60 + 15)
  }
  return beijingAt(new Date(startMs + 20 * 86400 * 1000), 9 * 60 + 15)
}

function beforeBoundary(date: Date, seconds: number, boundary: Date): Date {
  return new Date(Math.min(date.getTime() + Math.max(1, seconds) * 1000, boundary.getTime()))
}

// 给定 date 所在北京自然日的某分钟。minutes=9*60+15 即北京 09:15。
function beijingAt(date: Date, minutes: number): Date {
  const d = new Date(date.getTime() + BEIJING_OFFSET_MS)
  return new Date(Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
    Math.floor(minutes / 60) - 8, minutes % 60, 0, 0,
  ))
}

// 某天的北京 09:30(= UTC 01:30)。以给定 date 所在的北京日期为准。
function beijingMorningOpen(date: Date): Date {
  const d = new Date(date.getTime() + BEIJING_OFFSET_MS)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth()
  const day = d.getUTCDate()
  // 北京 09:30 = UTC 01:30
  return new Date(Date.UTC(y, m, day, 1, 30, 0))
}

// schema 校验:半日市/休市必须是字符串数组,valid_through 必须是 YYYY-MM-DD 且未过期。
function isValidCalendar(raw: unknown): raw is TradeCalendar {
  if (!raw || typeof raw !== 'object') return false
  const c = raw as Record<string, unknown>
  if (!Array.isArray(c.holidays) || !c.holidays.every(x => typeof x === 'string')) return false
  if (!Array.isArray(c.half_days) || !c.half_days.every(x => typeof x === 'string')) return false
  if (typeof c.valid_through !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(c.valid_through)) return false
  return true
}

// 读日历文件并校验。任何问题(缺失/JSON 坏/schema 坏/过期 stale)都返 null,绝不抛 ——
// 上层据此降级成“仅按周末推理”,不让日历问题拖垮调度。
export function loadTradeCalendarFile(path: string, referenceDate: Date = new Date()): TradeCalendar | null {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return null // 文件不存在或 JSON 坏
  }
  if (!isValidCalendar(raw)) return null
  // stale:valid_through 已过 → 日历不再可信,降级
  const today = beijingDateStr(referenceDate)
  if (raw.valid_through < today) return null
  return raw
}
