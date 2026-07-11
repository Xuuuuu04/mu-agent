// 自主盯盘 watchdog:盘中定时查持仓现价,触止损/止盈线主动告警。
// 设计要点(对标 Task D3 混合架构):
//  - 确定性定时器查价,不唤醒 LLM(省 token);只在触线时发模板告警。
//  - 非交易时段(周末/节假日/盘后)tick 自动跳过,不浪费报价调用。
//  - 每只票每个触发类型每天最多告警 1 条(冷却,防刷屏);跨天清空。
//  - 告警双写:alerts.log(本地必达)+ deliverToUser(微信,尽力,stale 可能丢 → log 兜底)。
// 价格获取 + 投递都走依赖注入,watchdog 不直接耦合 registry / bridge,便于单测。
import { readFileSync, existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Position } from './types.js'
import { atomicWriteJsonSync } from './atomic-file.js'
import { getMarketPhase, isTradingDay, loadTradeCalendarFile } from './market-hours.js'

// 只在这些时段查价(价格在动的真实交易窗口)。
const ACTIVE_PHASES = new Set(['call_auction', 'morning', 'afternoon', 'call_close'])

export type PriceFetcher = (codes: string[]) => Promise<Map<string, number>>
export type Deliver = (text: string) => Promise<void>

export interface Trigger {
  type: 'stop_loss' | 'stop_loss_near' | 'take_profit' | 'take_profit_near'
  line: number
}

export interface WatchdogDeps {
  dataDir: string
  fetchPrices: PriceFetcher
  deliverToUser: Deliver
  calendarPath?: string
  intervalSec?: number      // 默认 300
  nearPct?: number          // 默认 0.01
  now?: () => Date          // 测试注入
}

export interface WatchdogHealthSnapshot {
  status: 'idle' | 'healthy' | 'degraded'
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
}

interface WatchdogState {
  date: string              // YYYY-MM-DD(北京),跨天清 fired
  fired: string[]           // `${code}:${type}` 已告警
}

export class WatchdogManager {
  private deps: WatchdogDeps
  private intervalSec: number
  private nearPct: number
  private timer: ReturnType<typeof setInterval> | null = null
  private health: WatchdogHealthSnapshot

  constructor(deps: WatchdogDeps) {
    this.deps = deps
    this.intervalSec = deps.intervalSec ?? 300
    this.nearPct = deps.nearPct ?? 0.01
    this.health = this.loadHealth()
  }

  start(): void {
    if (this.timer) return
    const runTick = () => {
      this.tick().catch(err => console.error(`[watchdog] tick 失败: ${(err as Error).message}`))
    }
    runTick()
    this.timer = setInterval(runTick, this.intervalSec * 1000)
    this.timer.unref?.()  // 不阻止进程退出
    console.log(`[watchdog] 启动,每 ${this.intervalSec}s tick 一次(非交易时段自动跳过)`)
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  getHealthSnapshot(): WatchdogHealthSnapshot {
    return { ...this.health, prices: { ...this.health.prices }, missing_codes: [...this.health.missing_codes] }
  }

  // 一次检查。导出便于活测/测试直接调。
  async tick(): Promise<void> {
    const now = this.deps.now ? this.deps.now() : new Date()
    const nowIso = now.toISOString()
    const calendarPath = this.deps.calendarPath
      ?? join(this.deps.dataDir, 'memory', 'trade-calendar.json')
    const cal = loadTradeCalendarFile(calendarPath)
    const calendarError = !cal
      ? `calendar unavailable, invalid, or stale: ${calendarPath}`
      : null
    if (calendarError) console.error(`[watchdog] ${calendarError};降级为工作日规则`)
    // 只在真实交易时段(集合竞价/上午/下午/收盘集合)查价 ——
    // pre_market(含凌晨)/lunch/post_market/closed/非交易日都跳过:价格没在动,不浪费调用、不在半夜用昨收告警。
    const phase = getMarketPhase(now, cal)
    if (!isTradingDay(now, cal) || !ACTIVE_PHASES.has(phase)) {
      this.updateHealth({
        status: calendarError ? 'degraded' : 'idle',
        last_tick_at: nowIso,
        last_error: calendarError ?? this.health.last_error,
        last_error_at: calendarError ? nowIso : this.health.last_error_at,
        skipped_reason: 'outside_market',
      })
      return
    }

    let positions: Position[]
    try {
      positions = loadActivePositions(this.deps.dataDir)
    } catch (err) {
      const message = `portfolio load failed: ${(err as Error).message}`
      console.error(`[watchdog] ${message}`)
      this.updateHealth({
        status: 'degraded',
        last_tick_at: nowIso,
        active_position_count: 0,
        quote_count: 0,
        prices: {},
        as_of: null,
        missing_codes: [],
        last_error: message,
        last_error_at: nowIso,
        skipped_reason: null,
      })
      return
    }
    if (positions.length === 0) {
      this.updateHealth({
        status: calendarError ? 'degraded' : 'idle',
        last_tick_at: nowIso,
        active_position_count: 0,
        quote_count: 0,
        prices: {},
        as_of: null,
        missing_codes: [],
        last_error: calendarError ?? this.health.last_error,
        last_error_at: calendarError ? nowIso : this.health.last_error_at,
        skipped_reason: 'no_active_positions',
      })
      return
    }

    let prices: Map<string, number>
    try {
      prices = await this.deps.fetchPrices(positions.map(p => p.code))
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
      return
    }

    const currentPrices: Record<string, number> = {}
    const missingCodes: string[] = []
    for (const code of uniqueSorted(positions.map(p => p.code))) {
      const price = prices.get(code)
      if (price == null || !Number.isFinite(price) || price <= 0) missingCodes.push(code)
      else currentPrices[code] = price
    }
    const quoteCount = Object.keys(currentPrices).length
    const quoteError = missingCodes.length > 0
      ? `missing quotes for active positions: ${missingCodes.join(', ')}`
      : null
    const currentError = quoteError ?? calendarError
    this.updateHealth({
      status: currentError ? 'degraded' : 'healthy',
      last_tick_at: nowIso,
      last_success_at: missingCodes.length === 0 ? nowIso : this.health.last_success_at,
      active_position_count: positions.length,
      quote_count: quoteCount,
      prices: quoteCount > 0 ? currentPrices : this.health.prices,
      as_of: quoteCount > 0 ? nowIso : this.health.as_of,
      missing_codes: missingCodes,
      last_error: currentError ?? this.health.last_error,
      last_error_at: currentError ? nowIso : this.health.last_error_at,
      skipped_reason: null,
    })
    if (quoteError) console.error(`[watchdog] ${quoteError}`)

    const state = this.loadState(now)
    let fired = false
    for (const p of positions) {
      const price = prices.get(p.code)
      if (price == null || !Number.isFinite(price) || price <= 0) continue
      for (const trig of checkTriggers(p, price, this.nearPct)) {
        const key = `${p.code}:${trig.type}`
        if (state.fired.includes(key)) continue
        const text = alertText(p, price, trig, now)
        this.appendAlert(text)
        try { await this.deps.deliverToUser(text) } catch (err) {
          console.error(`[watchdog] 告警投递失败(alerts.log 已留底): ${(err as Error).message}`)
        }
        state.fired.push(key)
        fired = true
        console.log(`[watchdog] 告警: ${p.code} ${trig.type} @${price}`)
      }
    }
    if (fired) this.saveState(state)
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
        const s = JSON.parse(readFileSync(this.statePath(), 'utf-8')) as WatchdogState
        if (s.date === today && Array.isArray(s.fired)) return s
      } catch (err) {
        console.error(`[watchdog] 冷却状态读取失败,从当日空状态恢复: ${(err as Error).message}`)
      }
    }
    return { date: today, fired: [] }
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

// 解析 hexin-ifind-stock__stock_highfreq_quotes 的返回(嵌套 JSON:outer.data 是字符串)。
// tables[0]=表头(证券代码/证券简称/time/最新价/...),其后每行一只票。
export function parseIfindPrices(toolOutput: string): Map<string, number> {
  const map = new Map<string, number>()
  try {
    const outer = JSON.parse(toolOutput)
    const dataRaw = typeof outer === 'object' && outer !== null ? outer.data ?? outer : outer
    const inner = typeof dataRaw === 'string' ? JSON.parse(dataRaw) : dataRaw
    const tables = inner?.tables
    if (!Array.isArray(tables) || tables.length < 2) return map
    const header = tables[0] as string[]
    const codeIdx = header.indexOf('证券代码')
    const priceIdx = header.indexOf('最新价')
    if (codeIdx < 0 || priceIdx < 0) return map
    for (let i = 1; i < tables.length; i++) {
      const row = tables[i] as unknown[]
      const fullCode = String(row[codeIdx])            // '003816.SZ'
      const code = fullCode.split('.')[0]              // '003816'
      const price = Number(row[priceIdx])
      if (code && Number.isFinite(price) && price > 0) map.set(code, price)
    }
  } catch { /* 解析失败返空 map,watchdog 本轮跳过该票 */ }
  return map
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
  }
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort()
}

function beijingMinutes(date: Date): number {
  const d = new Date(date.getTime() + 8 * 3600 * 1000)
  return d.getUTCHours() * 60 + d.getUTCMinutes()
}
function beijingDateStr(date: Date): string {
  const d = new Date(date.getTime() + 8 * 3600 * 1000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}
