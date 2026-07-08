import { readFileSync, existsSync, unlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { MuConfig, MoodState, WakeTrigger } from './types.js'
import type { MemoryStore } from '../memory/store.js'
import { atomicWriteJsonSync } from './atomic-file.js'
import { beijingHour, getMarketPhase, loadTradeCalendarFile, type MarketPhase, type TradeCalendar } from './market-hours.js'

export type WakeKind = 'reminder' | 'task' | 'rest'

export interface ScheduledWake {
  id: string
  at: string
  reason: string
  activity_type: string
  kind: WakeKind
  interruptible: boolean
}

interface WakeFile {
  version: 2
  wakes: ScheduledWake[]
}

const MAX_TIMER_MS = 2_147_000_000

export class Scheduler {
  private config: MuConfig
  private store: MemoryStore
  private wakeTimer: ReturnType<typeof setTimeout> | null = null
  private cronTimer: ReturnType<typeof setInterval> | null = null
  private onWake: ((trigger: WakeTrigger) => void) | null = null
  private wakes: ScheduledWake[] = []
  private lastSuccessProbe: (() => Date | null) | null = null
  private readonly startedAt = Date.now()
  // 交易日历 mtime 缓存:文件没动就不重读重解析。键 = path + mtimeMs。
  private calendarCache: { path: string; mtimeMs: number; cal: TradeCalendar | null } | null = null

  constructor(config: MuConfig, store: MemoryStore) {
    this.config = config
    this.store = store
  }

  setWakeHandler(handler: (trigger: WakeTrigger) => void): void {
    this.onWake = handler
  }

  // mu.ts 注入:查询 agent-loop 最后一次成功 cycle 的时间,cron 兜底据此判断唤醒链是否断裂
  setLastSuccessProbe(fn: () => Date | null): void {
    this.lastSuccessProbe = fn
  }

  scheduleNext(suggested: { seconds: number; reason: string; activity_type: string }): string {
    const kind = wakeKind(suggested.activity_type)
    // reminder 是用户时钟语义，绝不能套旧“睡多久”的 clamp；task/rest 才走活跃度规则。
    const seconds = kind === 'reminder'
      ? Math.max(1, suggested.seconds)
      : this.clamp(suggested.seconds)
    const at = new Date(Date.now() + seconds * 1000).toISOString()
    const existing = kind === 'task'
      ? this.wakes.find(w => w.kind === 'task' && w.reason === suggested.reason)
      : undefined
    const wake: ScheduledWake = existing ?? {
      id: `wake_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      at,
      reason: suggested.reason,
      activity_type: suggested.activity_type,
      kind,
      interruptible: kind === 'rest',
    }
    wake.at = at
    wake.reason = suggested.reason
    wake.activity_type = suggested.activity_type

    if (!existing) {
      // rest 是旧自决睡眠语义，同一时间只保留一个；提醒和不同 task 都允许并存。
      if (kind === 'rest') this.wakes = this.wakes.filter(w => w.kind !== 'rest')
      this.wakes.push(wake)
    }
    this.sortWakes()
    this.persistWakes()
    this.armNext()

    this.store.logSchedule({
      wake_type: kind === 'reminder' ? 'reminder' : 'self_scheduled',
      reason: `${suggested.reason} (${suggested.activity_type})`,
      next_wake_seconds: seconds,
    })
    console.log(`[scheduler] 新增${kind}唤醒: ${seconds}秒后 (${suggested.reason})`)
    return wake.id
  }

  restoreWake(): void {
    const modern = this.wakesPath()
    if (existsSync(modern)) {
      try {
        const saved = JSON.parse(readFileSync(modern, 'utf-8')) as Partial<WakeFile>
        this.wakes = Array.isArray(saved.wakes)
          ? saved.wakes.filter(isScheduledWake)
          : []
      } catch {
        this.wakes = []
      }
    } else {
      this.migrateLegacyWake()
    }
    this.sortWakes()
    this.persistWakes()
    this.armNext()
    if (this.wakes.length > 0) {
      console.log(`[scheduler] 恢复 ${this.wakes.length} 个落盘唤醒`)
    }
  }

  private migrateLegacyWake(): void {
    const legacy = this.legacyWakePath()
    if (!existsSync(legacy)) return
    try {
      const saved = JSON.parse(readFileSync(legacy, 'utf-8')) as {
        at?: string
        reason?: string
        activity_type?: string
      }
      if (saved.at && saved.reason) {
        const activity = saved.activity_type || 'rest'
        const kind = wakeKind(activity)
        this.wakes.push({
          id: `wake_legacy_${Date.now().toString(36)}`,
          at: saved.at,
          reason: saved.reason,
          activity_type: activity,
          kind,
          interruptible: kind === 'rest',
        })
      }
    } catch {
      // 旧文件坏了就丢弃，不能让启动失败。
    } finally {
      try { unlinkSync(legacy) } catch { /* 不存在即可 */ }
    }
  }

  private armNext(): void {
    if (this.wakeTimer) clearTimeout(this.wakeTimer)
    this.wakeTimer = null
    const next = this.wakes[0]
    if (!next) return
    const delay = Math.max(0, Date.parse(next.at) - Date.now())
    this.wakeTimer = setTimeout(() => this.fireDue(), Math.min(delay, MAX_TIMER_MS))
  }

  private fireDue(): void {
    this.wakeTimer = null
    const now = Date.now()
    const due = this.wakes.filter(w => Date.parse(w.at) <= now + 1000)
    if (due.length === 0) {
      this.armNext() // 超长 timer 分段醒来重挂
      return
    }
    const dueIds = new Set(due.map(w => w.id))
    this.wakes = this.wakes.filter(w => !dueIds.has(w.id))
    this.persistWakes()
    this.armNext()
    for (const wake of due) {
      this.onWake?.({
        type: 'self_scheduled',
        reason: wake.reason,
        activity_type: wake.activity_type,
      })
    }
  }

  startCronFallback(): void {
    const intervalMs = this.config.scheduler.cron_fallback_seconds * 1000
    this.cronTimer = setInterval(() => {
      // 情况1: 有 pending wake 但超时 10 分钟没醒(timer 丢失/进程卡过)
      const oldestDue = this.wakes.find(w => Date.parse(w.at) < Date.now() - 10 * 60 * 1000)
      if (oldestDue) {
        console.log(`[scheduler] cron 兜底: 唤醒 ${oldestDue.id} 已逾期 10 分钟`)
        this.fireDue()
        return
      }

      // 情况2: 唤醒链断裂 —— 没有 pending wake(cycle 失败时模型没机会输出新 WAKE)且超 max_wake_seconds
      // 没有成功 cycle,无条件兜底唤醒。这是 06-09 死亡螺旋安全网:不依赖有没有待办,
      // 无 task 时醒来发现无事再睡是无害健康检查;链一断时它是唯一能把她叫回来的人。
      if (this.wakes.length > 0) return
      const last = this.lastSuccessProbe?.()
      const idleMs = Date.now() - (last?.getTime() ?? this.startedAt)
      if (idleMs <= this.config.scheduler.max_wake_seconds * 1000) return
      const idleMin = Math.round(idleMs / 60000)
      console.log(`[scheduler] cron 兜底: 唤醒链断裂(${idleMin}分钟无成功 cycle),强制唤醒`)
      this.store.logSchedule({
        wake_type: 'cron_fallback',
        reason: `wake chain broken, no successful cycle for ${idleMin}min`,
      })
      this.onWake?.({
        type: 'cron_fallback',
        reason: `好久没正常醒来了(${idleMin}分钟),被叫起来看看`,
      })
    }, intervalMs)
  }

  // 用户新消息只打断旧式“自主休息”；用户提醒和 Task 都是承诺，必须保留。
  interruptForMessage(): void {
    const before = this.wakes.length
    this.wakes = this.wakes.filter(w => !w.interruptible)
    if (this.wakes.length === before) return
    this.persistWakes()
    this.armNext()
    console.log(`[scheduler] 收到消息,取消 ${before - this.wakes.length} 个可中断唤醒`)
  }

  stop(): void {
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer)
      this.wakeTimer = null
    }
    if (this.cronTimer) {
      clearInterval(this.cronTimer)
      this.cronTimer = null
    }
  }

  getScheduledWakes(): ScheduledWake[] {
    return this.wakes.map(w => ({ ...w }))
  }

  // 保持旧 API：状态页展示最早一个 wake；完整列表由 getScheduledWakes 提供。
  getStatus(): { sleeping: boolean; nextWake: Date | null; reason: string } {
    const next = this.wakes[0]
    return {
      sleeping: !!next,
      nextWake: next ? new Date(next.at) : null,
      reason: next?.reason ?? '',
    }
  }

  private persistWakes(): void {
    try {
      atomicWriteJsonSync(this.wakesPath(), { version: 2, wakes: this.wakes })
    } catch {
      // 落盘失败不能拖垮当前对话；内存队列仍可继续工作。
    }
  }

  private wakesPath(): string {
    return join(this.config.paths.data, 'memory', 'next-wakes.json')
  }

  private legacyWakePath(): string {
    return join(this.config.paths.data, 'memory', 'next-wake.json')
  }

  private sortWakes(): void {
    this.wakes.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  }

  private clamp(seconds: number): number {
    const s = this.config.scheduler
    // beijingHour 修复(R1 抓的时区撕裂):marketPhase 按北京时间算,night 也必须按北京时间算,
    // 否则非 CST 部署盘中 morning 会被系统 getHours 判成 night,市场下限静默失效。
    const a = s.a_stock
    const marketPhase = a?.enabled && a.calendar_path ? this.currentMarketPhase() : null
    return clampWake(seconds, {
      hour: beijingHour(new Date()),
      nightStart: s.night_start_hour,
      nightEnd: s.night_end_hour,
      min: s.min_wake_seconds,
      maxSleep: s.max_sleep_seconds,
      nightMin: s.night_min_wake_seconds,
      moodSleepy: this.loadMood()?.current === 'sleepy',
      marketPhase,
      marketMinWake: a?.market_min_wake_seconds,
    })
  }

  // 当前 A 股时段。a_stock 未启用 / 无日历 → null(等同于不叠加市场下限)。
  private currentMarketPhase(): MarketPhase | null {
    const cal = this.loadCalendarCached()
    if (!cal) return null
    return getMarketPhase(new Date(), cal)
  }

  // 读日历并 mtime 缓存。文件缺失/坏/过期全返 null,绝不抛 —— 日历问题降级成“仅周末推理”,不拖垮调度。
  private loadCalendarCached(): TradeCalendar | null {
    const path = this.config.scheduler.a_stock?.calendar_path
    if (!path) return null
    try {
      const st = statSync(path) // 文件不存在抛 → catch → null
      if (this.calendarCache && this.calendarCache.path === path && this.calendarCache.mtimeMs === st.mtimeMs) {
        return this.calendarCache.cal
      }
      const cal = loadTradeCalendarFile(path) // 内部再校验 schema + stale,任一不过返 null
      this.calendarCache = { path, mtimeMs: st.mtimeMs, cal }
      return cal
    } catch {
      return null
    }
  }

  private loadMood(): MoodState | null {
    const path = join(this.config.paths.data, 'memory', 'mood.json')
    if (!existsSync(path)) return null
    try {
      return JSON.parse(readFileSync(path, 'utf-8'))
    } catch {
      return null
    }
  }
}

function wakeKind(activityType: string): WakeKind {
  if (activityType === 'reminder') return 'reminder'
  if (activityType === 'task') return 'task'
  return 'rest'
}

function isScheduledWake(value: unknown): value is ScheduledWake {
  if (!value || typeof value !== 'object') return false
  const w = value as Partial<ScheduledWake>
  return typeof w.id === 'string'
    && typeof w.at === 'string'
    && Number.isFinite(Date.parse(w.at))
    && typeof w.reason === 'string'
    && typeof w.activity_type === 'string'
    && (w.kind === 'reminder' || w.kind === 'task' || w.kind === 'rest')
    && typeof w.interruptible === 'boolean'
}

export interface ClampWakeConfig {
  hour: number
  nightStart: number
  nightEnd: number
  min: number
  maxSleep: number
  nightMin: number
  moodSleepy: boolean
  // A 股盘中叠加更紧的下限(更频繁盯盘)。marketPhase 为 null/undefined/closed,或夜间,或缺 marketMinWake → 不叠加=旧行为。
  marketPhase?: MarketPhase | null
  marketMinWake?: number
}

export function clampWake(seconds: number, c: ClampWakeConfig): number {
  const isNight = c.nightStart < c.nightEnd
    ? (c.hour >= c.nightStart && c.hour < c.nightEnd)
    : (c.hour >= c.nightStart || c.hour < c.nightEnd)
  let min = isNight ? c.nightMin : c.min
  if (c.moodSleepy) min = Math.max(min, 1800)
  // 市场下限叠加:盘中(morning/afternoon 等,非 closed)且非夜间 → 取更紧的下限(只降不升,更频繁盯盘)。
  if (c.marketPhase && c.marketPhase !== 'closed' && c.marketMinWake != null && !isNight) {
    min = Math.min(min, c.marketMinWake)
  }
  return Math.max(min, Math.min(c.maxSleep, seconds))
}
