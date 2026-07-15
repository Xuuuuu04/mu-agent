// 自主盯盘 watchdog:盘中定时查持仓现价,触止损/止盈线主动告警。
// 设计要点(对标 Task D3 混合架构):
//  - 确定性定时器查价,不唤醒 LLM(省 token);只在触线时发模板告警。
//  - 非交易时段(周末/节假日/盘后)tick 自动跳过,不浪费报价调用。
//  - 告警按风险状态迁移发送；跨天持续处于同一状态不重复，升级/恢复会重新通知。
//  - 告警双写:alerts.log(本地留底)+ deliverToUser；投递失败保留未送达状态并在后续 tick 重试。
// 价格获取 + 投递都走依赖注入,watchdog 不直接耦合 registry / bridge,便于单测。
import { readFileSync, existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Position } from './types.js'
import { atomicWriteJsonSync } from './atomic-file.js'
import { beijingDateStr, beijingMinutes, nextMarketMonitoringAt, type MarketPhase } from './market-hours.js'
import { MarketClock } from './market-clock.js'
import { reconcileQuotes } from '../finance/research-intelligence.js'

// 只在这些时段查价(价格在动的真实交易窗口)。
const ACTIVE_PHASES = new Set(['call_auction', 'morning', 'afternoon', 'call_close'])

export type PriceFetcher = (codes: string[]) => Promise<Map<string, number>>
export interface PriceQuotePoint {
  price: number
  asOf: string
  name?: string
  peTtm?: number
  pb?: number
  marketCapYi?: number
  sources?: string[]
}
export type DetailedPriceFetcher = (codes: string[]) => Promise<Map<string, PriceQuotePoint>>
export type Deliver = (text: string) => Promise<void>

export interface Trigger {
  type: 'stop_loss' | 'stop_loss_near' | 'take_profit' | 'take_profit_near'
  line: number
}

export interface WatchdogDeps {
  dataDir: string
  fetchPrices: PriceFetcher
  verifyPrices?: PriceFetcher
  fetchQuotePoints?: DetailedPriceFetcher
  verifyQuotePoints?: DetailedPriceFetcher
  recordQuoteCheck?: (value: Record<string, unknown>) => void
  recordSessionTick?: (now: Date, quoteCoverage: number, overlapSuppressed: number) => void
  researchCodes?: () => string[]
  recordResearchTick?: (value: {
    now: Date; positions: Position[]; quotes: Map<string, PriceQuotePoint>; benchmark?: PriceQuotePoint
  }) => void | Promise<void>
  deliverToUser: Deliver
  calendarPath?: string
  intervalSec?: number      // 默认 180
  auctionIntervalSec?: number // 集合竞价默认 60
  closeAuctionIntervalSec?: number // 收盘集合竞价默认 30
  nearPct?: number          // 默认 0.01
  now?: () => Date          // 测试注入
  marketClock?: MarketClock // 生产由 scheduler/watchdog 共享
  enabled?: boolean         // 生产显式传配置开关;测试默认 true
}

export interface WatchdogHealthSnapshot {
  status: 'disabled' | 'idle' | 'healthy' | 'degraded'
  enabled: boolean
  running: boolean
  last_tick_at: string | null
  last_success_at: string | null
  active_position_count: number
  quote_count: number
  prices: Record<string, number>
  as_of: string | null
  missing_codes: string[]
  last_error: string | null
  last_error_at: string | null
  skipped_reason: 'outside_market' | 'no_active_positions' | null
  phase: MarketPhase | null
  in_flight: boolean
  next_tick_at: string | null
  cadence_reason: string | null
  effective_interval_seconds: number | null
  overlap_suppressed: number
  quote_verification: 'not_configured' | 'consistent' | 'degraded' | 'divergent' | 'unavailable'
  verified_quote_count: number
}

interface WatchdogState {
  version: 2
  date: string              // 最近一次状态变化的北京时间日期，仅保留兼容审计
  fired: string[]           // 兼容旧审计；实际冷却由 active 状态机决定
  active: Record<string, { type: Trigger['type']; line: number | null; enteredAt: string; delivered?: boolean; recoveryPending?: boolean }>
}

export class WatchdogManager {
  private deps: WatchdogDeps
  private intervalSec: number
  private auctionIntervalSec: number
  private closeAuctionIntervalSec: number
  private nearPct: number
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private generation = 0
  private enabled: boolean
  private inFlight = false
  private health: WatchdogHealthSnapshot
  private marketClock: MarketClock

  constructor(deps: WatchdogDeps) {
    this.deps = deps
    this.intervalSec = deps.intervalSec ?? 180
    this.auctionIntervalSec = deps.auctionIntervalSec ?? 60
    this.closeAuctionIntervalSec = deps.closeAuctionIntervalSec ?? 30
    this.nearPct = deps.nearPct ?? 0.01
    this.enabled = deps.enabled ?? true
    this.marketClock = deps.marketClock ?? new MarketClock(this.calendarPath())
    this.health = this.loadHealth()
    this.health = {
      ...this.health,
      status: this.enabled ? (this.health.status === 'disabled' ? 'idle' : this.health.status) : 'disabled',
      enabled: this.enabled,
      running: false,
      in_flight: false,
      next_tick_at: null,
      cadence_reason: null,
      effective_interval_seconds: null,
    }
  }

  start(): void {
    if (!this.enabled || this.running) return
    this.running = true
    const generation = ++this.generation
    this.updateHealth({ running: true })
    void this.runAndSchedule(generation)
    console.log(`[watchdog] 启动,按交易阶段自适应调度(连续竞价 ${this.intervalSec}s)`)
  }

  stop(): void {
    this.running = false
    this.generation++
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.updateHealth({ running: false, next_tick_at: null, cadence_reason: null, effective_interval_seconds: null })
  }

  getHealthSnapshot(): WatchdogHealthSnapshot {
    return { ...this.health, prices: { ...this.health.prices }, missing_codes: [...this.health.missing_codes] }
  }

  // 一次检查。导出便于活测/测试直接调。
  async tick(): Promise<void> {
    if (this.inFlight) {
      this.updateHealth({ overlap_suppressed: this.health.overlap_suppressed + 1 })
      return
    }
    this.inFlight = true
    this.updateHealth({ in_flight: true })
    try {
      await this.performTick()
    } finally {
      this.inFlight = false
      this.updateHealth({ in_flight: false })
      const now = this.deps.now ? this.deps.now() : new Date()
      const coverage = this.health.active_position_count > 0 ? this.health.quote_count / this.health.active_position_count : 1
      try { this.deps.recordSessionTick?.(now, coverage, this.health.overlap_suppressed) } catch (error) {
        console.error(`[watchdog] 交易时段验收留证失败: ${(error as Error).message}`)
      }
    }
  }

  private async runAndSchedule(generation: number): Promise<void> {
    if (!this.running || generation !== this.generation) return
    try { await this.tick() } catch (err) {
      console.error(`[watchdog] tick 失败: ${(err as Error).message}`)
    }
    if (!this.running || generation !== this.generation) return
    const now = this.deps.now ? this.deps.now() : new Date()
    const context = this.marketClock.context(now)
    const cal = context.calendar
    const next = nextMarketMonitoringAt(
      now, cal, this.intervalSec, this.auctionIntervalSec, this.closeAuctionIntervalSec,
    )
    const phase = context.phase
    const delay = Math.max(1_000, next.getTime() - now.getTime())
    this.updateHealth({
      phase,
      next_tick_at: next.toISOString(),
      cadence_reason: cadenceReason(phase),
      effective_interval_seconds: Math.round(delay / 1000),
    })
    this.timer = setTimeout(() => {
      this.timer = null
      void this.runAndSchedule(generation)
    }, delay)
    this.timer.unref?.()
  }

  private calendarPath(): string {
    return this.deps.calendarPath ?? join(this.deps.dataDir, 'memory', 'trade-calendar.json')
  }

  private async performTick(): Promise<void> {
    const now = this.deps.now ? this.deps.now() : new Date()
    const nowIso = now.toISOString()
    const calendarPath = this.calendarPath()
    const context = this.marketClock.context(now)
    const calendarError = context.health.status === 'degraded'
      ? `calendar unavailable, invalid, or stale: ${calendarPath}`
      : null
    if (calendarError) console.error(`[watchdog] ${calendarError};降级为工作日规则`)
    let positions: Position[]
    try {
      positions = loadActivePositions(this.deps.dataDir)
    } catch (err) {
      const message = `portfolio load failed: ${(err as Error).message}`
      console.error(`[watchdog] ${message}`)
      this.updateHealth({ status: 'degraded', last_tick_at: nowIso, active_position_count: 0,
        quote_count: 0, prices: {}, as_of: null, missing_codes: [], last_error: message,
        last_error_at: nowIso, skipped_reason: null })
      return
    }
    // 只在真实交易时段(集合竞价/上午/下午/收盘集合)查价 ——
    // pre_market(含凌晨)/lunch/post_market/closed/非交易日都跳过:价格没在动,不浪费调用、不在半夜用昨收告警。
    const phase = context.phase
    if (!ACTIVE_PHASES.has(phase)) {
      this.updateHealth({
        status: calendarError ? 'degraded' : 'idle',
        last_tick_at: nowIso,
        active_position_count: positions.length,
        phase,
        last_error: calendarError,
        last_error_at: calendarError ? nowIso : null,
        skipped_reason: 'outside_market',
      })
      return
    }
    const activeCodesOrdered = uniqueSorted(positions.map(position => position.code))
    const activeCodeSet = new Set(activeCodesOrdered)
    const researchCodes = uniqueSorted(this.deps.researchCodes?.().filter(code => /^\d{6}$/.test(code)
      && !activeCodeSet.has(code)) ?? [])
    const monitoredCodes = [...activeCodesOrdered, ...researchCodes].slice(0, 600)
    if (monitoredCodes.length === 0) {
      this.updateHealth({
        status: calendarError ? 'degraded' : 'idle',
        last_tick_at: nowIso,
        active_position_count: 0,
        quote_count: 0,
        prices: {},
        as_of: null,
        missing_codes: [],
        phase,
        last_error: calendarError,
        last_error_at: calendarError ? nowIso : null,
        skipped_reason: 'no_active_positions',
      })
      return
    }

    let primaryPrices: Map<string, number>
    let verifierPrices: Map<string, number> | null = null
    let primaryPoints: Map<string, PriceQuotePoint> | null = null
    let verifierPoints: Map<string, PriceQuotePoint> | null = null
    try {
      const codes = monitoredCodes
      if (this.deps.fetchQuotePoints && this.deps.verifyQuotePoints) {
        const [primary, verifier] = await Promise.allSettled([this.deps.fetchQuotePoints(codes), this.deps.verifyQuotePoints(codes)])
        if (primary.status === 'rejected') throw primary.reason
        primaryPrices = new Map([...primary.value].map(([code, quote]) => [code, quote.price]))
        verifierPrices = verifier.status === 'fulfilled' ? new Map([...verifier.value].map(([code, quote]) => [code, quote.price])) : new Map()
        primaryPoints = primary.value
        verifierPoints = verifier.status === 'fulfilled' ? verifier.value : new Map()
      } else if (this.deps.verifyPrices) {
        const [primary, verifier] = await Promise.allSettled([this.deps.fetchPrices(codes), this.deps.verifyPrices(codes)])
        if (primary.status === 'rejected') throw primary.reason
        primaryPrices = primary.value
        verifierPrices = verifier.status === 'fulfilled' ? verifier.value : new Map()
      } else {
        primaryPrices = await this.deps.fetchPrices(codes)
      }
    } catch (err) {
      const message = `quote fetch failed: ${(err as Error).message}`
      console.error(`[watchdog] 取价失败,本轮降级: ${(err as Error).message}`)
      this.updateHealth({
        status: 'degraded',
        last_tick_at: nowIso,
        active_position_count: positions.length,
        missing_codes: uniqueSorted(positions.map(p => p.code)),
        last_error: message,
        last_error_at: nowIso,
        skipped_reason: null,
      })
      try { await this.deps.recordResearchTick?.({ now, positions, quotes: new Map() }) } catch (researchError) {
        console.error(`[watchdog] 每日研究缺口留证失败: ${(researchError as Error).message}`)
      }
      return
    }

    const prices = new Map<string, number>()
    const currentPrices: Record<string, number> = {}
    const missingCodes: string[] = activeCodesOrdered.slice(600)
    const qualityChecks: Array<Record<string, unknown>> = []
    let verifiedQuoteCount = 0
    const activeCodes = new Set(positions.map(position => position.code))
    for (const code of monitoredCodes) {
      let price = primaryPrices.get(code)
      if (this.deps.verifyPrices || (this.deps.fetchQuotePoints && this.deps.verifyQuotePoints)) {
        const observations = [
          { source: 'primary', price: primaryPrices.get(code) ?? Number.NaN, asOf: primaryPoints?.get(code)?.asOf ?? nowIso },
          { source: 'tencent', price: verifierPrices?.get(code) ?? Number.NaN, asOf: verifierPoints?.get(code)?.asOf ?? nowIso },
        ]
        const quality = reconcileQuotes(observations, now, { maxAgeSeconds: 15, toleranceBps: 20, minSources: 2 })
        qualityChecks.push({ code, checkedAt: nowIso, timestampBasis: primaryPoints ? 'source_time' : 'receipt_time', observations, ...quality })
        if (quality.status === 'consistent' && quality.consensusPrice !== null) {
          price = quality.consensusPrice
          if (activeCodes.has(code)) verifiedQuoteCount++
        } else price = undefined
      }
      if (price == null || !Number.isFinite(price) || price <= 0) {
        if (activeCodes.has(code)) missingCodes.push(code)
      } else {
        if (activeCodes.has(code)) currentPrices[code] = price
        prices.set(code, price)
      }
    }
    const quoteVerification: WatchdogHealthSnapshot['quote_verification'] = !(this.deps.verifyPrices || this.deps.verifyQuotePoints) ? 'not_configured'
      : qualityChecks.every(x => x.status === 'consistent') ? 'consistent'
      : qualityChecks.some(x => x.status === 'divergent') ? 'divergent'
      : qualityChecks.some(x => x.status === 'unavailable') ? 'unavailable' : 'degraded'
    for (const quality of qualityChecks) {
      try { this.deps.recordQuoteCheck?.(quality) } catch (error) {
        console.error(`[watchdog] 行情质量留证失败: ${(error as Error).message}`)
      }
    }
    const quoteCount = Object.keys(currentPrices).length
    const quoteError = missingCodes.length > 0
      ? `missing quotes for active positions: ${missingCodes.join(', ')}`
      : null
    const currentError = quoteError ?? calendarError
    this.updateHealth({
      status: currentError ? 'degraded' : 'healthy',
      phase,
      last_tick_at: nowIso,
      last_success_at: missingCodes.length === 0 ? nowIso : this.health.last_success_at,
      active_position_count: positions.length,
      quote_count: quoteCount,
      prices: quoteCount > 0 ? currentPrices : this.health.prices,
      as_of: quoteCount > 0 ? nowIso : this.health.as_of,
      missing_codes: missingCodes,
      last_error: currentError,
      last_error_at: currentError ? nowIso : null,
      skipped_reason: null,
      quote_verification: quoteVerification,
      verified_quote_count: verifiedQuoteCount,
    })
    if (quoteError) console.error(`[watchdog] ${quoteError}`)

    if (this.deps.recordResearchTick) {
      const researchQuotes = new Map<string, PriceQuotePoint>()
      for (const [code, price] of prices) {
        const detail = verifierPoints?.get(code) ?? primaryPoints?.get(code)
        const quality = qualityChecks.find(item => item.code === code)
        const sources = Array.isArray(quality?.acceptedSources)
          ? quality.acceptedSources.filter(source => typeof source === 'string') as string[] : []
        researchQuotes.set(code, { ...(detail ?? { asOf: nowIso }), price, ...(sources.length ? { sources } : {}) })
      }
      try {
        await this.deps.recordResearchTick({ now, positions, quotes: researchQuotes,
          ...(verifierPoints?.get('000300') ? { benchmark: verifierPoints.get('000300') } : {}) })
      } catch (error) {
        console.error(`[watchdog] 每日研究留证失败: ${(error as Error).message}`)
      }
    }

    const state = this.loadState(now)
    let changed = false
    for (const p of positions) {
      const price = prices.get(p.code)
      if (price == null || !Number.isFinite(price) || price <= 0) continue
      const current = new Map(checkTriggers(p, price, this.nearPct).map(trigger => [triggerFamily(trigger.type), trigger]))
      for (const family of ['stop_loss', 'take_profit'] as const) {
        const stateKey = `${p.code}:${family}`
        const previous = state.active[stateKey]
        const trigger = current.get(family)
        if (trigger) {
          const transitioned = !previous || previous.type !== trigger.type
            || (previous.line !== null && previous.line !== trigger.line)
          let delivered = previous?.delivered !== false
          if (transitioned) {
            delivered = await this.emitAlert(alertText(p, price, trigger, now))
            console.log(`[watchdog] 告警状态变化: ${p.code} ${previous?.type ?? 'safe'} -> ${trigger.type} @${price}`)
          } else if (previous?.delivered === false) {
            delivered = await this.emitAlert(alertText(p, price, trigger, now), false)
          }
          if (transitioned || previous?.line === null || previous?.delivered !== delivered || previous?.recoveryPending) {
            state.active[stateKey] = { type: trigger.type, line: trigger.line,
              enteredAt: transitioned ? nowIso : previous?.enteredAt ?? nowIso, delivered }
            const legacyKey = `${p.code}:${trigger.type}`
            if (!state.fired.includes(legacyKey)) state.fired.push(legacyKey)
            state.date = beijingDateStr(now)
            changed = true
          }
        } else if (previous) {
          const delivered = await this.emitAlert(recoveryText(p, price, previous.type, now), !previous.recoveryPending)
          if (delivered) delete state.active[stateKey]
          else state.active[stateKey] = { ...previous, recoveryPending: true }
          state.date = beijingDateStr(now)
          changed = true
          if (delivered) console.log(`[watchdog] 告警恢复: ${p.code} ${previous.type} -> safe @${price}`)
        }
      }
    }
    if (changed) this.saveState(state)
  }

  // ── 状态落盘(冷却)──
  private statePath(): string { return join(this.deps.dataDir, 'memory', 'watchdog-state.json') }
  private healthPath(): string { return join(this.deps.dataDir, 'memory', 'watchdog-health.json') }
  private alertPath(): string { return join(this.deps.dataDir, 'memory', 'alerts.log') }

  private loadHealth(): WatchdogHealthSnapshot {
    const initial = emptyHealth()
    if (!existsSync(this.healthPath())) return initial
    try {
      const raw = JSON.parse(readFileSync(this.healthPath(), 'utf-8')) as Partial<WatchdogHealthSnapshot>
      return {
        ...initial,
        ...raw,
        prices: raw.prices && typeof raw.prices === 'object' ? raw.prices : {},
        missing_codes: Array.isArray(raw.missing_codes) ? raw.missing_codes : [],
      }
    } catch (err) {
      console.error(`[watchdog] 健康快照读取失败,从空状态恢复: ${(err as Error).message}`)
      return initial
    }
  }

  private updateHealth(patch: Partial<WatchdogHealthSnapshot>): void {
    this.health = {
      ...this.health,
      ...patch,
      prices: patch.prices ? { ...patch.prices } : { ...this.health.prices },
      missing_codes: patch.missing_codes ? [...patch.missing_codes] : [...this.health.missing_codes],
    }
    try {
      atomicWriteJsonSync(this.healthPath(), this.health, 2)
    } catch (err) {
      const message = `health snapshot write failed: ${(err as Error).message}`
      this.health = { ...this.health, status: 'degraded', last_error: message, last_error_at: this.health.last_tick_at }
      console.error(`[watchdog] ${message}`)
    }
  }

  private loadState(now: Date): WatchdogState {
    const today = beijingDateStr(now)
    if (existsSync(this.statePath())) {
      try {
        const s = JSON.parse(readFileSync(this.statePath(), 'utf-8')) as Partial<WatchdogState>
        if (s.version === 2 && Array.isArray(s.fired) && s.active && typeof s.active === 'object') {
          return { version: 2, date: typeof s.date === 'string' ? s.date : today,
            fired: s.fired.filter(value => typeof value === 'string'), active: s.active }
        }
        // v1 每日 fired 迁移：保留触发类型，line 首次见到时补齐且不重复发送。
        if (Array.isArray(s.fired)) {
          const active: WatchdogState['active'] = {}
          for (const value of s.fired) {
            if (typeof value !== 'string') continue
            const [code, type] = value.split(':')
            if (!code || !isTriggerType(type)) continue
            active[`${code}:${triggerFamily(type)}`] = { type, line: null, enteredAt: new Date().toISOString(), delivered: true }
          }
          return { version: 2, date: typeof s.date === 'string' ? s.date : today, fired: s.fired as string[], active }
        }
      } catch (err) {
        console.error(`[watchdog] 冷却状态读取失败,从空状态恢复: ${(err as Error).message}`)
      }
    }
    return { version: 2, date: today, fired: [], active: {} }
  }

  private saveState(state: WatchdogState): void {
    try { atomicWriteJsonSync(this.statePath(), state, 2) } catch (err) {
      console.error(`[watchdog] 冷却状态写入失败: ${(err as Error).message}`)
    }
  }

  private appendAlert(text: string): void {
    try { appendFileSync(this.alertPath(), text + '\n') } catch (err) {
      console.error(`[watchdog] alerts.log 写入失败: ${(err as Error).message}`)
    }
  }

  private async emitAlert(text: string, append = true): Promise<boolean> {
    if (append) this.appendAlert(text)
    try { await this.deps.deliverToUser(text); return true } catch (err) {
      console.error(`[watchdog] 告警投递失败(alerts.log 已留底): ${(err as Error).message}`)
      return false
    }
  }
}

// ── 纯函数(导出便于单测)──

// 比对止损/止盈(含接近缓冲)。返回触发的类型。
export function checkTriggers(p: Position, price: number, nearPct: number): Trigger[] {
  const out: Trigger[] = []
  if (p.stop_loss != null && p.stop_loss > 0) {
    if (price <= p.stop_loss) out.push({ type: 'stop_loss', line: p.stop_loss })
    else if (price <= p.stop_loss * (1 + nearPct)) out.push({ type: 'stop_loss_near', line: p.stop_loss })
  }
  if (p.take_profit != null && p.take_profit > 0) {
    if (price >= p.take_profit) out.push({ type: 'take_profit', line: p.take_profit })
    else if (price >= p.take_profit * (1 - nearPct)) out.push({ type: 'take_profit_near', line: p.take_profit })
  }
  return out
}

export function alertText(p: Position, price: number, trig: Trigger, now: Date): string {
  const ts = beijingDateStr(now) + ' ' + String(Math.floor(beijingMinutes(now) / 60)).padStart(2, '0') + ':' + String(beijingMinutes(now) % 60).padStart(2, '0')
  const what = trig.type === 'stop_loss' ? `⚠️ 触止损 ${p.name}(${p.code}) 现价 ${price} ≤ 止损 ${trig.line}`
    : trig.type === 'stop_loss_near' ? `⚠️ 接近止损 ${p.name}(${p.code}) 现价 ${price},距止损 ${trig.line} 仅 ${(price - trig.line).toFixed(2)}`
    : trig.type === 'take_profit' ? `✅ 触止盈 ${p.name}(${p.code}) 现价 ${price} ≥ 止盈 ${trig.line}`
    : `✅ 接近止盈 ${p.name}(${p.code}) 现价 ${price},距止盈 ${trig.line} 仅 ${(trig.line - price).toFixed(2)}`
  return `[${ts}] ${what}(成本 ${p.cost},${trig.type.includes('stop_loss') ? '注意风险' : '考虑兑现'})`
}

function recoveryText(p: Position, price: number, previous: Trigger['type'], now: Date): string {
  const ts = beijingDateStr(now) + ' ' + String(Math.floor(beijingMinutes(now) / 60)).padStart(2, '0') + ':' + String(beijingMinutes(now) % 60).padStart(2, '0')
  const label = previous.startsWith('stop_loss') ? '止损风险区' : '止盈触发区'
  return `[${ts}] ✅ ${p.name}(${p.code}) 已脱离${label}，现价 ${price}(成本 ${p.cost})`
}

function triggerFamily(type: Trigger['type']): 'stop_loss' | 'take_profit' {
  return type.startsWith('stop_loss') ? 'stop_loss' : 'take_profit'
}

function isTriggerType(value: string | undefined): value is Trigger['type'] {
  return value === 'stop_loss' || value === 'stop_loss_near' || value === 'take_profit' || value === 'take_profit_near'
}

// 解析 hexin-ifind-stock__stock_highfreq_quotes 的返回(嵌套 JSON:outer.data 是字符串)。
// tables[0]=表头(证券代码/证券简称/time/最新价/...),其后每行一只票。
export function parseIfindPrices(toolOutput: string): Map<string, number> {
  return new Map([...parseIfindQuotePoints(toolOutput)].map(([code, quote]) => [code, quote.price]))
}

export function parseIfindQuotePoints(toolOutput: string): Map<string, PriceQuotePoint> {
  try {
    const outer = JSON.parse(toolOutput)
    const dataRaw = typeof outer === 'object' && outer !== null ? outer.data ?? outer : outer
    const inner = typeof dataRaw === 'string' ? JSON.parse(dataRaw) : dataRaw
    const tables = inner?.tables
    if (!Array.isArray(tables) || tables.length < 2) return new Map()
    const header = tables[0] as string[]
    const codeIdx = header.indexOf('证券代码')
    const priceIdx = header.indexOf('最新价')
    const timeIdx = header.indexOf('time')
    if (codeIdx < 0 || priceIdx < 0 || timeIdx < 0) return new Map()
    const points = new Map<string, PriceQuotePoint>()
    for (let i = 1; i < tables.length; i++) {
      const row = tables[i] as unknown[]
      const fullCode = String(row[codeIdx])            // '003816.SZ'
      const code = fullCode.split('.')[0]              // '003816'
      const price = Number(row[priceIdx])
      const timeText = String(row[timeIdx] ?? '').trim().replace(' ', 'T')
      const time = new Date(`${timeText}+08:00`)
      if (code && Number.isFinite(price) && price > 0 && Number.isFinite(time.getTime())) {
        points.set(code, { price, asOf: time.toISOString(), sources: ['primary'] })
      }
    }
    return points
  } catch { /* 解析失败返空 map,watchdog 本轮跳过该票 */ }
  return new Map()
}

// ── 内部小工具(北京日期/分钟,避免循环依赖 market-hours 的导出函数都 OK,这里直接复用)──
function loadActivePositions(dataDir: string): Position[] {
  const path = join(dataDir, 'memory', 'portfolio.json')
  if (!existsSync(path)) return []
  try {
    const all = JSON.parse(readFileSync(path, 'utf-8')) as Position[]
    if (!Array.isArray(all)) throw new Error('portfolio.json root must be an array')
    return all.filter(p => p.status === 'active')
  } catch (err) {
    throw new Error(`${path}: ${(err as Error).message}`, { cause: err })
  }
}

function emptyHealth(): WatchdogHealthSnapshot {
  return {
    status: 'idle',
    enabled: true,
    running: false,
    last_tick_at: null,
    last_success_at: null,
    active_position_count: 0,
    quote_count: 0,
    prices: {},
    as_of: null,
    missing_codes: [],
    last_error: null,
    last_error_at: null,
    skipped_reason: null,
    phase: null,
    in_flight: false,
    next_tick_at: null,
    cadence_reason: null,
    effective_interval_seconds: null,
    overlap_suppressed: 0,
    quote_verification: 'not_configured',
    verified_quote_count: 0,
  }
}

function cadenceReason(phase: MarketPhase): string {
  if (phase === 'call_auction') return 'opening_auction_cadence'
  if (phase === 'morning' || phase === 'afternoon') return 'continuous_trading_cadence'
  if (phase === 'call_close') return 'closing_auction_cadence'
  if (phase === 'pre_market') return 'await_opening_auction'
  if (phase === 'lunch') return 'await_afternoon_session'
  return 'await_next_trading_day'
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort()
}
