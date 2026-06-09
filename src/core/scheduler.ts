import { readFileSync, existsSync } from 'node:fs'
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

    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null
      this.scheduledWakeAt = null
      this.onWake?.({
        type: 'self_scheduled',
        reason: suggested.reason,
        activity_type: suggested.activity_type,
      })
    }, clamped * 1000)
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

  private clamp(seconds: number): number {
    const hour = new Date().getHours()
    // 深夜判断要支持跨午夜（如 23-7），写法对齐 proactive.ts 的 quiet 时段
    const ns = this.config.scheduler.night_start_hour
    const ne = this.config.scheduler.night_end_hour
    const isNight = ns < ne ? (hour >= ns && hour < ne) : (hour >= ns || hour < ne)

    let min = this.config.scheduler.min_wake_seconds
    const max = this.config.scheduler.max_wake_seconds

    if (isNight) {
      min = this.config.scheduler.night_min_wake_seconds
    }

    const mood = this.loadMood()
    if (mood?.current === 'sleepy') {
      min = Math.max(min, 1800)
    }

    return Math.max(min, Math.min(max, seconds))
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
