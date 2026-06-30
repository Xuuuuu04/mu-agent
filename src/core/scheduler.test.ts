import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { clampWake, type ClampWakeConfig } from './scheduler.js'
import { Scheduler } from './scheduler.js'
import type { MemoryStore } from '../memory/store.js'
import type { MuConfig, WakeTrigger } from './types.js'

// 当前活跃参数基线:min 120 / maxSleep 28800(8h) / night_min 1800,深夜 23-7
const base: Omit<ClampWakeConfig, 'hour' | 'moodSleepy'> = {
  nightStart: 23, nightEnd: 7, min: 120, maxSleep: 28800, nightMin: 1800,
}
const cfg = (over: Partial<ClampWakeConfig>): ClampWakeConfig =>
  ({ ...base, hour: 12, moodSleepy: false, ...over })

test('正常时段:夹在 [min, maxSleep] 之间', () => {
  assert.equal(clampWake(600, cfg({ hour: 12 })), 600)
  assert.equal(clampWake(30, cfg({ hour: 12 })), 120)     // < min → min
  assert.equal(clampWake(99999, cfg({ hour: 12 })), 28800) // > maxSleep → maxSleep
})

test('深夜跨午夜判断:23 点和 3 点都算夜间,下限抬到 night_min', () => {
  assert.equal(clampWake(300, cfg({ hour: 23 })), 1800)  // 23 点夜间
  assert.equal(clampWake(300, cfg({ hour: 3 })), 1800)   // 3 点夜间
  assert.equal(clampWake(300, cfg({ hour: 6 })), 1800)   // 6 点仍夜间(<7)
})

test('深夜边界:7 点不算夜间(night_end 开区间)', () => {
  assert.equal(clampWake(300, cfg({ hour: 7 })), 300)    // 7 点白天,300 > min 直接过
})

test('sleepy 心情:下限抬到 ≥1800,即使白天', () => {
  assert.equal(clampWake(300, cfg({ hour: 12, moodSleepy: true })), 1800)
})

test('sleepy 不会突破 maxSleep', () => {
  assert.equal(clampWake(99999, cfg({ hour: 12, moodSleepy: true })), 28800)
})

test('过夜睡眠:WAKE 53460(~14h)被 maxSleep 夹到 28800(8h),不再夹到 1h', () => {
  assert.equal(clampWake(53460, cfg({ hour: 16 })), 28800)
})

function schedulerFixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'shion-scheduler-'))
  mkdirSync(join(dataDir, 'memory'), { recursive: true })
  const config = {
    scheduler: {
      min_wake_seconds: 120,
      max_wake_seconds: 3600,
      max_sleep_seconds: 28800,
      cron_fallback_seconds: 900,
      night_min_wake_seconds: 1800,
      night_start_hour: 23,
      night_end_hour: 7,
    },
    paths: { data: dataDir },
  } as MuConfig
  const store = { logSchedule() {} } as unknown as MemoryStore
  const scheduler = new Scheduler(config, store)
  return {
    dataDir,
    scheduler,
    cleanup() {
      scheduler.stop()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

test('用户提醒不受 max_sleep clamp:24 小时后仍约 24 小时', () => {
  const s = schedulerFixture()
  try {
    const before = Date.now()
    s.scheduler.scheduleNext({ seconds: 86400, reason: '明天开会', activity_type: 'reminder' })
    const wake = s.scheduler.getScheduledWakes()[0]!
    const delay = new Date(wake.at).getTime() - before
    assert.ok(delay >= 86_399_000 && delay <= 86_401_000, `实际 delay=${delay}`)
  } finally { s.cleanup() }
})

test('多个提醒和 task wake 可并存,按时间排序且不互相覆盖', () => {
  const s = schedulerFixture()
  try {
    s.scheduler.scheduleNext({ seconds: 7200, reason: '提醒二', activity_type: 'reminder' })
    s.scheduler.scheduleNext({ seconds: 3600, reason: '提醒一', activity_type: 'reminder' })
    s.scheduler.scheduleNext({ seconds: 600, reason: '推进任务 task_a', activity_type: 'task' })
    const wakes = s.scheduler.getScheduledWakes()
    assert.equal(wakes.length, 3)
    assert.deepEqual(wakes.map(w => w.activity_type), ['task', 'reminder', 'reminder'])
    assert.deepEqual(wakes.map(w => w.reason), ['推进任务 task_a', '提醒一', '提醒二'])
  } finally { s.cleanup() }
})

test('普通消息只打断可中断的 rest wake,保留 reminder 和 task', () => {
  const s = schedulerFixture()
  try {
    s.scheduler.scheduleNext({ seconds: 900, reason: '自主休息', activity_type: 'rest' })
    s.scheduler.scheduleNext({ seconds: 1200, reason: '用户提醒', activity_type: 'reminder' })
    s.scheduler.scheduleNext({ seconds: 600, reason: '推进任务 task_a', activity_type: 'task' })
    s.scheduler.interruptForMessage()
    const wakes = s.scheduler.getScheduledWakes()
    assert.deepEqual(wakes.map(w => w.activity_type).sort(), ['reminder', 'task'])
  } finally { s.cleanup() }
})

test('wake 队列持久化并兼容迁移旧 next-wake.json', () => {
  const s = schedulerFixture()
  try {
    const legacy = join(s.dataDir, 'memory', 'next-wake.json')
    writeFileSync(legacy, JSON.stringify({
      at: new Date(Date.now() + 3600_000).toISOString(),
      reason: '旧提醒',
      activity_type: 'reminder',
    }))
    s.scheduler.restoreWake()
    assert.equal(s.scheduler.getScheduledWakes()[0]?.reason, '旧提醒')
    assert.ok(existsSync(join(s.dataDir, 'memory', 'next-wakes.json')))
    assert.equal(existsSync(legacy), false)
  } finally { s.cleanup() }
})

// cron 兜底回归基线:锁住 06-09 死亡螺旋安全网(Codex 曾静默删除,只被 review 抓到)。
// fired 收所有 onWake,logs 收 logSchedule;wake-handler 不再实际醒来,只记录触发。
function cronFixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'shion-cron-'))
  mkdirSync(join(dataDir, 'memory'), { recursive: true })
  const config = {
    scheduler: {
      min_wake_seconds: 120,
      max_wake_seconds: 3600,
      max_sleep_seconds: 28800,
      cron_fallback_seconds: 900,
      night_min_wake_seconds: 1800,
      night_start_hour: 23,
      night_end_hour: 7,
    },
    paths: { data: dataDir },
  } as MuConfig
  const logs: { wake_type: string; reason?: string }[] = []
  const store = { logSchedule(e: { wake_type: string; reason?: string }) { logs.push(e) } } as unknown as MemoryStore
  const scheduler = new Scheduler(config, store)
  const fired: WakeTrigger[] = []
  scheduler.setWakeHandler(t => fired.push(t))
  return {
    dataDir, scheduler, fired, logs,
    cleanup() {
      scheduler.stop()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

test('cron 兜底 情况2:空队列且超 max_wake_seconds 无成功 cycle → 无条件唤醒(不依赖任何待办)', (t) => {
  // 这是 06-09 10 小时停摆的同类 bug 的安全网。enable setTimeout 也 mock,确保 arm 的 timer 不漏跑。
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
  const s = cronFixture()
  try {
    // 队列为空(cycle 失败时模型没机会输出新 WAKE);lastSuccess 远在过去 → idle 远超 max_wake。
    s.scheduler.setLastSuccessProbe(() => new Date(-10_000_000))
    s.scheduler.startCronFallback()
    t.mock.timers.tick(900 * 1000) // 一个 cron interval
    assert.equal(s.fired.length, 1)
    assert.equal(s.fired[0]!.type, 'cron_fallback')
    assert.equal(s.logs.filter(l => l.wake_type === 'cron_fallback').length, 1)
  } finally { s.cleanup() }
})

test('cron 兜底 情况2 阈值内:空队列但 idle ≤ max_wake_seconds → 不唤醒', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
  const s = cronFixture()
  try {
    // mock Date 起点 0,lastSuccess 也设 0 → 第一个 cron tick 时 idle=900s < max_wake 3600s。
    s.scheduler.setLastSuccessProbe(() => new Date(0))
    s.scheduler.startCronFallback()
    t.mock.timers.tick(900 * 1000)
    assert.equal(s.fired.length, 0)
  } finally { s.cleanup() }
})

test('cron 兜底 情况2 负例:有 pending wake 且未逾期 → 不产生多余唤醒', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
  const s = cronFixture()
  try {
    s.scheduler.setLastSuccessProbe(() => new Date(-10_000_000)) // idle 很大,但队列非空应短路
    s.scheduler.scheduleNext({ seconds: 7200, reason: '提醒', activity_type: 'reminder' }) // 2h 后,tick 内不逾期
    s.scheduler.startCronFallback()
    t.mock.timers.tick(900 * 1000)
    assert.equal(s.fired.length, 0)
  } finally { s.cleanup() }
})

test('cron 兜底 情况1:pending wake 逾期超 10 分钟(timer 丢失)→ 兜底唤醒', (t) => {
  // 只 mock setInterval + Date,setTimeout 保持真实 → wake 自身的 armNext timer 在测试墙钟内不会触发,
  // 模拟“timer 丢失/进程卡过”;唯一能唤醒的是 cron 逾期分支。
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] })
  const s = cronFixture()
  try {
    s.scheduler.scheduleNext({ seconds: 120, reason: '推进任务', activity_type: 'task' })
    s.scheduler.startCronFallback()
    // mock now 推到 900s:wake.at=120s,逾期 780s > 10min 阈值 → cron 逾期分支 fireDue。
    t.mock.timers.tick(900 * 1000)
    assert.equal(s.fired.length, 1)
    assert.equal(s.fired[0]!.type, 'self_scheduled')
    assert.equal(s.fired[0]!.reason, '推进任务')
  } finally { s.cleanup() }
})
