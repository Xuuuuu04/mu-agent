import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProactiveManager, decideCanSend } from './proactive.js'
import type { MuConfig, WakeTrigger } from './types.js'

// ── decideCanSend 纯决策(深夜防扰/每小时上限/连续未回降频)──
const at = (hour: number) => new Date(2026, 5, 16, hour, 0, 0).getTime()
const QC = { quietStart: 1, quietEnd: 8, maxPerHour: 5 }

test('decideCanSend: 深夜(1-8)不打扰', () => {
  assert.equal(decideCanSend(at(2), [], 0, QC).ok, false)
  assert.equal(decideCanSend(at(7), [], 0, QC).ok, false)   // 7 点仍静默(<8)
  assert.equal(decideCanSend(at(8), [], 0, QC).ok, true)    // 8 点解禁
  assert.equal(decideCanSend(at(14), [], 0, QC).ok, true)
})

test('decideCanSend: quiet 跨午夜(23-7)', () => {
  const c = { quietStart: 23, quietEnd: 7, maxPerHour: 5 }
  assert.equal(decideCanSend(at(23), [], 0, c).ok, false)
  assert.equal(decideCanSend(at(3), [], 0, c).ok, false)
  assert.equal(decideCanSend(at(12), [], 0, c).ok, true)
})

test('decideCanSend: 每小时上限(滑窗,过期的不算)', () => {
  const now = at(14)
  const recent = [now - 1000, now - 2000, now - 3000, now - 4000, now - 5000]   // 5 条近 1h
  assert.equal(decideCanSend(now, recent, 0, QC).ok, false, '满 5 条挡住')
  const old = recent.map(t => t - 3700_000)                                      // 都超 1h
  const r = decideCanSend(now, old, 0, QC)
  assert.equal(r.ok, true, '过期的剪掉后未满')
  assert.equal(r.prunedLog.length, 0, '过期时间戳被剪')
})

test('decideCanSend: 连续 3 条没回降频', () => {
  assert.equal(decideCanSend(at(14), [], 3, QC).ok, false)
  assert.equal(decideCanSend(at(14), [], 2, QC).ok, true)
})

test('decideCanSend: 深夜时不剪 sentLog(prune 在 quiet 检查之后)', () => {
  const log = [at(2) - 9999_999]
  assert.deepEqual(decideCanSend(at(2), log, 0, QC).prunedLog, log)
})

// proactive.ts 的频率保护逻辑(canSendNow/collectReasons/dueCommitments/evaluate)全是 private,
// 唯一入口是 start() 装的 10 分钟 setInterval,且 canSendNow 直接读 new Date().getHours()——
// 没法注入时钟。所以这里只能 characterize 可观测面:
//   1. 公共方法 onUserMessage/recordSent 对计数器的影响
//   2. 这些计数器经 saveState 落盘到 proactive-state.json 的结构(频率保护扛 pm2 重启的关键)
//   3. loadState 启动恢复(经构造+读盘验证):坏文件/缺字段的容错
// quiet_hour 跨午夜、每小时上限、unrepliedStreak>=3 这些判断本身在 canSendNow 里测不到,
// 在 skipped 报告。这里测的是它们依赖的状态如何被维护和持久化。

function baseConfig(over: Partial<NonNullable<MuConfig['proactive']>> = {}): MuConfig {
  return {
    proactive: {
      enabled: true,
      max_per_hour: 5,
      quiet_start_hour: 1,
      quiet_end_hour: 8,
      ...over,
    },
  } as unknown as MuConfig
}

// ProactiveManager 把 state 写到 <dataDir>/memory/proactive-state.json
function withManager(
  fn: (mgr: ProactiveManager, dataDir: string, stateFile: string) => void | Promise<void>,
  config: MuConfig = baseConfig(),
): void | Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'mu-proactive-'))
  // saveState 直接 writeFileSync 到 memory/ 子目录,得先建出来(否则写盘静默失败)
  mkdirSync(join(dataDir, 'memory'), { recursive: true })
  const stateFile = join(dataDir, 'memory', 'proactive-state.json')
  const cleanup = () => rmSync(dataDir, { recursive: true, force: true })
  try {
    const r = fn(new ProactiveManager(config, dataDir), dataDir, stateFile)
    if (r instanceof Promise) return r.finally(cleanup)
    cleanup()
  } catch (e) { cleanup(); throw e }
}

function readState(stateFile: string): Record<string, unknown> {
  return JSON.parse(readFileSync(stateFile, 'utf-8'))
}

// 写 mood.json(loadMood 从这里读,但本测试套件不依赖它驱动 collectReasons)
function writeMood(dataDir: string, current: string): void {
  writeFileSync(join(dataDir, 'memory', 'mood.json'), JSON.stringify({ current, since: new Date().toISOString() }))
}

// ── recordSent: sentLog / unrepliedStreak ──────────────────────────────

test('recordSent 把时间戳推进 sentLog 并 +1 unrepliedStreak,落盘', () => withManager((mgr, _d, stateFile) => {
  const before = Date.now()
  mgr.recordSent()
  const s = readState(stateFile)
  assert.equal((s.sentLog as number[]).length, 1)
  assert.ok((s.sentLog as number[])[0]! >= before, 'sentLog 时间戳应是当前时刻')
  assert.equal(s.unrepliedStreak, 1)
}))

test('连续 recordSent 累加 sentLog 与 unrepliedStreak(每小时上限的计数基础)', () => withManager((mgr, _d, stateFile) => {
  mgr.recordSent()
  mgr.recordSent()
  mgr.recordSent()
  const s = readState(stateFile)
  assert.equal((s.sentLog as number[]).length, 3)
  assert.equal(s.unrepliedStreak, 3)
}))

// ── onUserMessage: 重置 unrepliedStreak,刷新 lastContactAt ──────────────

test('onUserMessage 清零 unrepliedStreak(哥哥回了就解除降频)', () => withManager((mgr, _d, stateFile) => {
  mgr.recordSent()
  mgr.recordSent()
  mgr.recordSent()
  assert.equal(readState(stateFile).unrepliedStreak, 3)
  mgr.onUserMessage()
  assert.equal(readState(stateFile).unrepliedStreak, 0)
}))

test('onUserMessage 刷新 lastContactAt 落盘(想念触发的 2 小时计时锚点)', () => withManager((mgr, _d, stateFile) => {
  const before = Date.now()
  mgr.onUserMessage()
  const s = readState(stateFile)
  assert.equal(typeof s.lastContactAt, 'number')
  assert.ok((s.lastContactAt as number) >= before)
}))

test('onUserMessage 不动 sentLog(回复不消费每小时配额)', () => withManager((mgr, _d, stateFile) => {
  mgr.recordSent()
  mgr.recordSent()
  mgr.onUserMessage()
  // sentLog 仍是 2 条:onUserMessage 只重置 streak,不清发送历史
  assert.equal((readState(stateFile).sentLog as number[]).length, 2)
}))

// ── 想念配额 missingCountToday:只在 lastTriggerHadMissing 时计入 ─────────

test('裸 recordSent(无想念触发)不计入想念配额', () => withManager((mgr, _d, stateFile) => {
  // lastTriggerHadMissing 默认 false(只有 private evaluate 见到"想哥哥了"才置 true)
  mgr.recordSent()
  const s = readState(stateFile)
  // 没经 evaluate 设标志,recordSent 不碰 missingCountToday/lastMissingDay
  assert.equal(s.missingCountToday, 0)
  assert.equal(s.lastMissingDay, '')
}))

// ── 状态落盘结构:扛 pm2 重启的全字段快照 ─────────────────────────────

test('saveState 落盘包含全部 7 个保护字段', () => withManager((mgr, _d, stateFile) => {
  mgr.recordSent()
  const s = readState(stateFile)
  for (const k of ['sentLog', 'lastContactAt', 'unrepliedStreak', 'lastMissingDay', 'missingCountToday', 'firedDay', 'firedCommitments']) {
    assert.ok(k in s, `落盘应含字段 ${k}`)
  }
  assert.ok(Array.isArray(s.sentLog))
  assert.ok(Array.isArray(s.firedCommitments))
}))

// ── loadState 启动恢复:经 start() 触发,验证读盘容错 ──────────────────
// start() 会 loadState() 再装 setInterval。装完立刻 stop() 清掉定时器(否则进程不退)。

test('start() loadState 恢复 sentLog/unrepliedStreak(重启后频率窗口不清零)', () => withManager((mgr, _d, stateFile) => {
  // 先手写一份"重启前"的状态
  const past = Date.now() - 1000
  writeFileSync(stateFile, JSON.stringify({
    sentLog: [past, past + 1],
    lastContactAt: past,
    unrepliedStreak: 2,
    lastMissingDay: '2026-06-15',
    missingCountToday: 1,
    firedDay: '2026-06-15',
    firedCommitments: ['给哥哥做饭'],
  }))
  mgr.start()
  mgr.stop()
  // 恢复后再 recordSent,sentLog 应在原 2 条基础上 +1,unrepliedStreak 从 2 -> 3
  mgr.recordSent()
  const s = readState(stateFile)
  assert.equal((s.sentLog as number[]).length, 3, '恢复的 sentLog 应保留再追加')
  assert.equal(s.unrepliedStreak, 3, 'unrepliedStreak 应从恢复值 2 继续 +1')
  assert.equal(s.lastMissingDay, '2026-06-15')
  assert.deepEqual(s.firedCommitments, ['给哥哥做饭'])
}))

test('start() 对坏 JSON 状态文件容错:当全新开始,不抛', () => withManager((mgr, _d, stateFile) => {
  writeFileSync(stateFile, '{ 这不是合法 JSON')
  assert.doesNotThrow(() => { mgr.start(); mgr.stop() })
  // 坏文件被忽略,recordSent 从空 sentLog 起步
  mgr.recordSent()
  assert.equal((readState(stateFile).sentLog as number[]).length, 1)
}))

test('start() 缺字段的状态文件:用默认值补齐,不抛', () => withManager((mgr, _d, stateFile) => {
  writeFileSync(stateFile, JSON.stringify({ unrepliedStreak: 5 }))  // 只有一个字段
  assert.doesNotThrow(() => { mgr.start(); mgr.stop() })
  mgr.recordSent()
  const s = readState(stateFile)
  // sentLog 缺失 -> 默认 []，recordSent 后为 1
  assert.equal((s.sentLog as number[]).length, 1)
  // unrepliedStreak 从 5 恢复,+1 = 6
  assert.equal(s.unrepliedStreak, 6)
  // 缺失的计数字段补默认
  assert.equal(s.missingCountToday, 0)
  assert.equal(s.lastMissingDay, '')
}))

test('start() sentLog 非数组时回退空数组(loadState 的 Array.isArray 守卫)', () => withManager((mgr, _d, stateFile) => {
  writeFileSync(stateFile, JSON.stringify({ sentLog: 'oops', firedCommitments: 'nope' }))
  mgr.start(); mgr.stop()
  mgr.recordSent()
  const s = readState(stateFile)
  assert.equal((s.sentLog as number[]).length, 1, 'sentLog 非数组应回退 [] 再追加')
  assert.ok(Array.isArray(s.firedCommitments))
}))

// ── start() 在 proactive 未启用时早退,不读盘不装定时器 ──────────────────

test('proactive.enabled=false 时 start() 不 loadState 不装定时器', () => withManager((mgr, _d, stateFile) => {
  // 写一份会被恢复的状态;若 start 早退,recordSent 应从空起步(没恢复 unrepliedStreak)
  writeFileSync(stateFile, JSON.stringify({ sentLog: [1, 2, 3], unrepliedStreak: 9 }))
  mgr.start()  // enabled=false -> 立即 return
  mgr.stop()
  mgr.recordSent()
  const s = readState(stateFile)
  // 没 loadState,所以 sentLog 从内存初值 [] 起步,recordSent 后只有 1 条
  assert.equal((s.sentLog as number[]).length, 1, 'enabled=false 不应恢复旧 sentLog')
  assert.equal(s.unrepliedStreak, 1, 'enabled=false 不应恢复旧 unrepliedStreak')
}, baseConfig({ enabled: false })))

// ── firedCommitments Set <-> Array 序列化往返 ─────────────────────────

test('firedCommitments 经 Set 内部表示后落盘为数组', () => withManager((mgr, _d, stateFile) => {
  writeFileSync(stateFile, JSON.stringify({
    sentLog: [], firedCommitments: ['a', 'b', 'a'],  // 含重复
  }))
  mgr.start(); mgr.stop()
  mgr.recordSent()  // 触发 saveState
  const fired = readState(stateFile).firedCommitments as string[]
  // Set 去重:['a','b','a'] -> {'a','b'}
  assert.deepEqual([...new Set(fired)].sort(), ['a', 'b'])
  assert.equal(fired.length, 2, 'Set 应去掉重复的 a')
}))

// ── stop() 幂等:没 start 直接 stop 不抛 ───────────────────────────────

test('stop() 在未 start 时调用安全(timer 为 null)', () => withManager((mgr) => {
  assert.doesNotThrow(() => mgr.stop())
  assert.doesNotThrow(() => { mgr.stop(); mgr.stop() })
}))

// ── 边界:saveState 写盘目标目录存在性 ───────────────────────────────────

test('recordSent 写盘后文件真实存在且可二次读回', () => withManager((mgr, _d, stateFile) => {
  assert.equal(existsSync(stateFile), false, '初始无状态文件')
  mgr.recordSent()
  assert.equal(existsSync(stateFile), true)
  // 再 record 一次,sentLog 累加(确认是 append 不是覆盖新文件)
  mgr.recordSent()
  assert.equal((readState(stateFile).sentLog as number[]).length, 2)
}))

// mood.json 存在但本套件不靠它驱动 evaluate;这里仅确认 writeMood 帮助函数本身不污染状态
test('写 mood.json 不影响 proactive-state(两套独立文件)', () => withManager((mgr, dataDir, stateFile) => {
  writeMood(dataDir, 'missing')
  mgr.recordSent()
  const s = readState(stateFile)
  // proactive-state 里没有 mood 字段
  assert.equal('current' in s, false)
  assert.equal((s.sentLog as number[]).length, 1)
}))
