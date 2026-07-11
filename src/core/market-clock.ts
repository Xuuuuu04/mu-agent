import { statSync } from 'node:fs'
import { beijingDateStr, getMarketPhase, loadTradeCalendarFile, type MarketPhase, type TradeCalendar } from './market-hours.js'

export interface MarketClockHealth {
  enabled: boolean
  status: 'disabled' | 'healthy' | 'degraded'
  path: string | null
  last_checked_at: string | null
  last_error: string | null
}

export interface MarketContext {
  now: Date
  phase: MarketPhase
  calendar: TradeCalendar | null
  health: MarketClockHealth
}

// 进程内唯一交易时钟:统一日历缓存、北京时间阶段和降级状态。
// scheduler 与 watchdog 共享同一实例,不再各自读取、各自解释同一份日历。
export class MarketClock {
  private cache: { mtimeMs: number; beijingDate: string; calendar: TradeCalendar | null } | null = null
  private health: MarketClockHealth

  constructor(private readonly path: string, private readonly enabled = true) {
    this.health = enabled
      ? { enabled: true, status: 'degraded', path, last_checked_at: null, last_error: 'calendar not checked' }
      : { enabled: false, status: 'disabled', path: null, last_checked_at: null, last_error: null }
  }

  context(now: Date = new Date()): MarketContext {
    const calendar = this.load(now)
    return { now, phase: getMarketPhase(now, calendar), calendar, health: { ...this.health } }
  }

  getHealthSnapshot(now: Date = new Date()): MarketClockHealth {
    if (this.enabled) this.load(now)
    return { ...this.health }
  }

  private load(now: Date): TradeCalendar | null {
    if (!this.enabled) return null
    const checkedAt = now.toISOString()
    const today = beijingDateStr(now)
    try {
      const stat = statSync(this.path)
      if (this.cache?.mtimeMs === stat.mtimeMs && this.cache.beijingDate === today) {
        this.setHealth(checkedAt, this.cache.calendar)
        return this.cache.calendar
      }
      const calendar = loadTradeCalendarFile(this.path, now)
      this.cache = { mtimeMs: stat.mtimeMs, beijingDate: today, calendar }
      this.setHealth(checkedAt, calendar)
      return calendar
    } catch {
      this.cache = null
      this.setHealth(checkedAt, null)
      return null
    }
  }

  private setHealth(checkedAt: string, calendar: TradeCalendar | null): void {
    this.health = {
      enabled: true,
      status: calendar ? 'healthy' : 'degraded',
      path: this.path,
      last_checked_at: checkedAt,
      last_error: calendar ? null : 'calendar unavailable, invalid, or stale',
    }
  }
}
