import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clampWake, type ClampWakeConfig } from './scheduler.js'

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
