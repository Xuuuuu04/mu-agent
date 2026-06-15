import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { MuConfig, MoodState, WakeTrigger } from './types.js'
import type { MemoryStore } from '../memory/store.js'

export class Scheduler {
  private config: MuConfig
  private store: MemoryStore
  private wakeTimer: ReturnType<typeof setTimeout> | null = null
  private cronTimer: ReturnType<typeof setInterval> | null = null
  private onWake: ((trigger: WakeTrigger) => void) | null = null
  private scheduledWakeAt: Date | null = null
  private lastWakeReason = ''
  private lastSuccessProbe: (() => Date | null) | null = null
  private readonly startedAt = Date.now()

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

  scheduleNext(suggested: { seconds: number; reason: string; activity_type: string }): void {
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer)
      this.wakeTimer = null
    }

    const clamped = this.clamp(suggested.seconds)
    this.scheduledWakeAt = new Date(Date.now() + clamped * 1000)
    this.lastWakeReason = suggested.reason

    this.store.logSchedule({
      wake_type: 'self_scheduled',
      reason: `${suggested.reason} (${suggested.activity_type})`,
      next_wake_seconds: clamped,
    })

    console.log(`[scheduler] 下次醒来: ${clamped}秒后 (${suggested.reason})`)

    // 闹钟落盘:进程重启(部署/崩溃)时不丢她定好的"下次醒来"
    this.saveWakeFile(suggested.reason, suggested.activity_type)

    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null
      this.scheduledWakeAt = null
      this.clearWakeFile()
      this.onWake?.({
        type: 'self_scheduled',
        reason: suggested.reason,
        activity_type: suggested.activity_type,
      })
    }, clamped * 1000)
  }

  // 进程启动时恢复落盘的闹钟:还没到点就重新挂上;已经过点就马上叫醒她(补觉醒来)
  restoreWake(): void {
    const path = join(this.config.paths.data, 'memory', 'next-wake.json')
    if (!existsSync(path)) return
    try {
      const saved = JSON.parse(readFileSync(path, 'utf-8')) as { at: string; reason: string; activity_type: string }
      const remainMs = new Date(saved.at).getTime() - Date.now()
      if (remainMs > 5000) {
        this.scheduledWakeAt = new Date(saved.at)
        this.lastWakeReason = saved.reason
        console.log(`[scheduler] 恢复落盘闹钟: ${Math.round(remainMs / 1000)}秒后 (${saved.reason})`)
        this.wakeTimer = setTimeout(() => {
          this.wakeTimer = null
          this.scheduledWakeAt = null
          this.clearWakeFile()
          this.onWake?.({ type: 'self_scheduled', reason: saved.reason, activity_type: saved.activity_type })
        }, remainMs)
      } else {
        console.log(`[scheduler] 落盘闹钟已过点,立即唤醒 (${saved.reason})`)
        this.clearWakeFile()
        this.onWake?.({ type: 'self_scheduled', reason: `${saved.reason}(重启后补醒)`, activity_type: saved.activity_type })
      }
    } catch { this.clearWakeFile() }
  }

  private saveWakeFile(reason: string, activityType: string): void {
    try {
      writeFileSync(
        join(this.config.paths.data, 'memory', 'next-wake.json'),
        JSON.stringify({ at: this.scheduledWakeAt?.toISOString(), reason, activity_type: activityType }),
      )
    } catch { /* 落盘失败不影响内存闹钟 */ }
  }

  private clearWakeFile(): void {
    try { unlinkSync(join(this.config.paths.data, 'memory', 'next-wake.json')) } catch { /* 不存在就算了 */ }
  }

  startCronFallback(): void {
    const intervalMs = this.config.scheduler.cron_fallback_seconds * 1000

    this.cronTimer = setInterval(() => {
      // 情况1: 有 pending wake 但超时 10 分钟没醒(timer 丢失/进程卡过)
      if (this.scheduledWakeAt) {
        const overdue = Date.now() - this.scheduledWakeAt.getTime()
        if (overdue > 10 * 60 * 1000) {
          console.log(`[scheduler] cron 兜底: 超过 scheduled time 10 分钟未醒来`)
          this.store.logSchedule({
            wake_type: 'cron_fallback',
            reason: `missed scheduled wake by ${Math.round(overdue / 60000)}min`,
          })
          this.scheduledWakeAt = null
          if (this.wakeTimer) {
            clearTimeout(this.wakeTimer)
            this.wakeTimer = null
          }
          this.onWake?.({
            type: 'cron_fallback',
            reason: `错过了计划唤醒(${this.lastWakeReason})`,
          })
        }
        return
      }

      // 情况2: 唤醒链断裂 —— 没有 pending wake(cycle 失败时模型没机会输出新的 WAKE),
      // 且超过 max_wake_seconds 没有成功 cycle。原来只查情况1,链一断兜底就成摆设(06-09 事故瘫了 10 小时)。
      const last = this.lastSuccessProbe?.()
      const idleMs = Date.now() - (last?.getTime() ?? this.startedAt)
      if (idleMs > this.config.scheduler.max_wake_seconds * 1000) {
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
      }
    }, intervalMs)
  }

  interruptForMessage(): void {
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer)
      this.wakeTimer = null
      this.scheduledWakeAt = null
      this.clearWakeFile()
      console.log('[scheduler] 收到消息,打断 sleep')
    }
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

  getStatus(): { sleeping: boolean; nextWake: Date | null; reason: string } {
    return {
      sleeping: this.scheduledWakeAt !== null,
      nextWake: this.scheduledWakeAt,
      reason: this.lastWakeReason,
    }
  }

  // 采集时间/心情/config 这些副作用源,纯算法委托给 clampWake(可单测)
  private clamp(seconds: number): number {
    const s = this.config.scheduler
    return clampWake(seconds, {
      hour: new Date().getHours(),
      nightStart: s.night_start_hour,
      nightEnd: s.night_end_hour,
      min: s.min_wake_seconds,
      max: s.max_wake_seconds,
      nightMin: s.night_min_wake_seconds,
      moodSleepy: this.loadMood()?.current === 'sleepy',
    })
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

export interface ClampWakeConfig {
  hour: number          // 当前小时(0-23)
  nightStart: number    // 深夜起始小时
  nightEnd: number      // 深夜结束小时
  min: number           // 正常时段最小唤醒间隔(秒)
  max: number           // 最大唤醒间隔(秒)
  nightMin: number      // 深夜最小唤醒间隔(秒)
  moodSleepy: boolean   // 当前心情是否 sleepy
}

// 把建议的唤醒秒数夹到合理区间。纯算法,无副作用,便于单测。
// 深夜判断支持跨午夜(如 23-7),写法对齐 proactive.ts 的 quiet 时段;sleepy 时下限抬到 ≥30 分钟。
export function clampWake(seconds: number, c: ClampWakeConfig): number {
  const isNight = c.nightStart < c.nightEnd
    ? (c.hour >= c.nightStart && c.hour < c.nightEnd)
    : (c.hour >= c.nightStart || c.hour < c.nightEnd)
  let min = isNight ? c.nightMin : c.min
  if (c.moodSleepy) min = Math.max(min, 1800)
  return Math.max(min, Math.min(c.max, seconds))
}
