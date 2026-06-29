// active-tasks.ts 单测:状态机非法跳转被拒、backoff 计算、pickNextWakeFromTasks 过滤+取最早、
// bumpWakeCount 落盘 + 写失败 fail-closed、空文件/坏文件不崩、写盘前时间绝对化。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  loadTasks, saveTasks, validateTransition, backoffSeconds,
  pickNextWakeFromTasks, bumpWakeCount, markBlocked, shouldBlockForFailStreak,
  taskProgressSig, recordTaskProgress, blockCappedTasks,
  pendingBlockedNotices, formatBlockedNotices, addNotifiedBlocked,
  MAX_ACTIVE_TASKS, MAX_WAKES_PER_TASK, BACKOFF_BASE,
} from './active-tasks.js'
import type { Task, TaskStatus } from '../core/types.js'

// 临时 dataDir,跑完清理
function withDir(fn: (dataDir: string) => void): void {
  const dataDir = mkdtempSync(join(tmpdir(), 'mu-tasks-'))
  try { fn(dataDir) } finally { rmSync(dataDir, { recursive: true, force: true }) }
}

const tasksFile = (dataDir: string) => join(dataDir, 'memory', 'active-tasks.json')

function mkTask(over: Partial<Task> = {}): Task {
  return {
    id: 'task_a',
    title: 'T',
    dod: '',
    status: 'open',
    source: { channel: 'cli', raw: 'r', at: '2026-06-29T00:00:00.000Z' },
    steps: [],
    review: [],
    next_step: '',
    last_progress: '',
    wake_count: 0,
    fail_streak: 0,
    next_wake_at: null,
    blocked_reason: null,
    created: '2026-06-29',
    updated: '2026-06-29T00:00:00.000Z',
    ...over,
  }
}

// ── 读写:空文件 / 坏文件不崩 ──────────────────────────────

test('loadTasks:文件不存在返回空结构,不崩', () => withDir((dataDir) => {
  const data = loadTasks(dataDir)
  assert.deepEqual(data, { tasks: [], notified_blocked: [] })
}))

test('loadTasks:坏 JSON 不抛,返空 + log', () => withDir((dataDir) => {
  mkdirSync(join(dataDir, 'memory'), { recursive: true })
  writeFileSync(tasksFile(dataDir), '{ 这不是 json', 'utf-8')
  let logged = ''
  const data = loadTasks(dataDir, (m) => { logged = m })
  assert.deepEqual(data, { tasks: [], notified_blocked: [] })
  assert.match(logged, /读坏/)
}))

test('loadTasks:tasks 字段不是数组时降级为空数组', () => withDir((dataDir) => {
  mkdirSync(join(dataDir, 'memory'), { recursive: true })
  writeFileSync(tasksFile(dataDir), JSON.stringify({ tasks: 'oops' }), 'utf-8')
  const data = loadTasks(dataDir)
  assert.deepEqual(data.tasks, [])
  assert.deepEqual(data.notified_blocked, [])
}))

test('saveTasks→loadTasks round-trip', () => withDir((dataDir) => {
  const t = mkTask({ id: 'task_rt' })
  assert.equal(saveTasks(dataDir, { tasks: [t], notified_blocked: ['task_x'] }), true)
  const data = loadTasks(dataDir)
  assert.equal(data.tasks.length, 1)
  assert.equal(data.tasks[0]!.id, 'task_rt')
  assert.deepEqual(data.notified_blocked, ['task_x'])
}))

// ── 写盘前时间绝对化 ───────────────────────────────────────

test('saveTasks:写盘前固化 title/dod/next_step/due/steps[].text 里的"明天"', () => withDir((dataDir) => {
  const t = mkTask({
    title: '明天写周报',
    dod: '明天前覆盖三个项目',
    next_step: '明天先列提纲',
    due: '明天',
    steps: [{ id: 's1', text: '明天调研', status: 'todo' }],
  })
  saveTasks(dataDir, { tasks: [t], notified_blocked: [] })
  const raw = readFileSync(tasksFile(dataDir), 'utf-8')
  assert.ok(!raw.includes('明天'), '所有含时间字段的"明天"都被固化')
  const data = loadTasks(dataDir)
  const saved = data.tasks[0]!
  assert.match(saved.title, /\d+月\d+日/)
  assert.match(saved.dod, /\d+月\d+日/)
  assert.match(saved.next_step, /\d+月\d+日/)
  assert.match(saved.due!, /\d+月\d+日/)
  assert.match(saved.steps[0]!.text, /\d+月\d+日/)
}))

// ── 状态机校验 ─────────────────────────────────────────────

test('validateTransition:合法链 open→in_progress→in_review→done', () => {
  const open = mkTask({ status: 'open' })
  assert.equal(validateTransition(open, 'in_progress').ok, true)

  const inProg = mkTask({
    status: 'in_progress', dod: '验收', steps: [{ id: 's1', text: 'x', status: 'done' }],
  })
  assert.equal(validateTransition(inProg, 'in_review').ok, true)

  const inReview = mkTask({
    status: 'in_review',
    review: [{ at: '2026-06-29T00:00:00.000Z', verdict: 'pass', note: 'ok', by: 'self' }],
  })
  assert.equal(validateTransition(inReview, 'done').ok, true)
})

test('validateTransition:非法跳转被拒(open→done / open→in_review / done→任意)', () => {
  for (const [from, to] of [['open', 'done'], ['open', 'in_review'], ['in_progress', 'done']] as [TaskStatus, TaskStatus][]) {
    const r = validateTransition(mkTask({ status: from }), to)
    assert.equal(r.ok, false, `${from}→${to} 应被拒`)
    assert.match(r.error!, /非法状态跳转|前/)
  }
  // done 是终态,出不去
  const r = validateTransition(mkTask({ status: 'done' }), 'in_progress')
  assert.equal(r.ok, false)
  assert.match(r.error!, /非法状态跳转/)
})

test('validateTransition:进 in_review 要求 dod 非空', () => {
  const t = mkTask({ status: 'in_progress', dod: '', steps: [{ id: 's1', text: 'x', status: 'done' }] })
  const r = validateTransition(t, 'in_review')
  assert.equal(r.ok, false)
  assert.match(r.error!, /dod/)
})

test('validateTransition:进 in_review 要求 steps 全 done,force 可跳过', () => {
  const t = mkTask({ status: 'in_progress', dod: '验收', steps: [{ id: 's1', text: 'x', status: 'todo' }] })
  assert.equal(validateTransition(t, 'in_review').ok, false)
  assert.equal(validateTransition(t, 'in_review', { force: true }).ok, true, 'force 跳过 steps 检查')
})

test('validateTransition:置 done 要求 review[last].verdict===pass', () => {
  const noReview = mkTask({ status: 'in_review', review: [] })
  assert.equal(validateTransition(noReview, 'done').ok, false)

  const failReview = mkTask({
    status: 'in_review',
    review: [{ at: '2026-06-29T00:00:00.000Z', verdict: 'fail', note: '没过', by: 'self' }],
  })
  assert.equal(validateTransition(failReview, 'done').ok, false)
})

test('validateTransition:review fail 回 in_progress 合法', () => {
  const t = mkTask({ status: 'in_review' })
  assert.equal(validateTransition(t, 'in_progress').ok, true)
})

test('validateTransition:任意非 done→blocked 合法但要 reason;unblock 回原状态', () => {
  // 没 reason 被拒
  assert.equal(validateTransition(mkTask({ status: 'in_progress', blocked_reason: null }), 'blocked').ok, false)
  // 有 reason 放行
  assert.equal(validateTransition(mkTask({ status: 'in_progress', blocked_reason: '等哥哥确认' }), 'blocked').ok, true)
  // blocked→in_progress(unblock)合法
  assert.equal(validateTransition(mkTask({ status: 'blocked' }), 'in_progress').ok, true)
})

// ── backoff 计算 ───────────────────────────────────────────

test('backoffSeconds:600 * 2^min(streak,4),封顶 9600s', () => {
  assert.equal(backoffSeconds(0), 600)
  assert.equal(backoffSeconds(1), 1200)
  assert.equal(backoffSeconds(2), 2400)
  assert.equal(backoffSeconds(3), 4800)
  assert.equal(backoffSeconds(4), 9600)
  assert.equal(backoffSeconds(5), 9600, '封顶')
  assert.equal(backoffSeconds(99), 9600, '封顶')
})

test('shouldBlockForFailStreak:fail_streak>=3 触发', () => {
  assert.equal(shouldBlockForFailStreak(mkTask({ fail_streak: 2 })), false)
  assert.equal(shouldBlockForFailStreak(mkTask({ fail_streak: 3 })), true)
})

// ── pickNextWakeFromTasks ──────────────────────────────────

test('pickNextWakeFromTasks:空 / 全非可推进态返回 null', () => {
  assert.equal(pickNextWakeFromTasks([], Date.now()), null)
  const tasks = [
    mkTask({ id: 'a', status: 'done' }),
    mkTask({ id: 'b', status: 'in_review' }),
    mkTask({ id: 'c', status: 'blocked', blocked_reason: 'x' }),
  ]
  assert.equal(pickNextWakeFromTasks(tasks, Date.now()), null)
})

test('pickNextWakeFromTasks:只挑 open/in_progress 且 wake_count<MAX', () => {
  const now = Date.now()
  const tasks = [
    mkTask({ id: 'maxed', status: 'open', wake_count: MAX_WAKES_PER_TASK }), // 到顶,排除
    mkTask({ id: 'live', status: 'in_progress', wake_count: 1 }),
  ]
  const pick = pickNextWakeFromTasks(tasks, now)
  assert.ok(pick)
  assert.equal(pick!.taskId, 'live')
})

test('pickNextWakeFromTasks:取 next_wake_at 最早的(fail_streak 小→间隔短→更早)', () => {
  const updated = '2026-06-29T00:00:00.000Z'
  const now = Date.parse(updated)
  const tasks = [
    mkTask({ id: 'slow', status: 'open', fail_streak: 4, updated }), // +9600s
    mkTask({ id: 'fast', status: 'open', fail_streak: 0, updated }), // +600s
  ]
  const pick = pickNextWakeFromTasks(tasks, now)
  assert.equal(pick!.taskId, 'fast')
  assert.equal(pick!.wakeAt, new Date(now + 600_000).toISOString())
})

test('pickNextWakeFromTasks:updated 不可解析时用 now 兜底', () => {
  const now = 1_750_000_000_000
  const pick = pickNextWakeFromTasks([mkTask({ id: 'bad', status: 'open', updated: 'garbage' })], now)
  assert.ok(pick)
  assert.equal(pick!.wakeAt, new Date(now + 600_000).toISOString())
})

// ── bumpWakeCount(落盘 + fail-closed)─────────────────────

test('bumpWakeCount:wake_count +1 落盘,返 true', () => withDir((dataDir) => {
  saveTasks(dataDir, { tasks: [mkTask({ id: 'task_b', wake_count: 2 })], notified_blocked: [] })
  assert.equal(bumpWakeCount(dataDir, 'task_b'), true)
  assert.equal(loadTasks(dataDir).tasks[0]!.wake_count, 3)
}))

test('bumpWakeCount:找不到 task 返 false,不改文件', () => withDir((dataDir) => {
  saveTasks(dataDir, { tasks: [mkTask({ id: 'task_b', wake_count: 2 })], notified_blocked: [] })
  assert.equal(bumpWakeCount(dataDir, 'task_nope'), false)
  assert.equal(loadTasks(dataDir).tasks[0]!.wake_count, 2)
}))

test('bumpWakeCount:写盘失败 fail-closed(返 false)', () => withDir((dataDir) => {
  // 把 memory 路径占成普通文件,使 mkdir/write 失败
  writeFileSync(join(dataDir, 'memory'), 'occupied', 'utf-8')
  assert.equal(bumpWakeCount(dataDir, 'task_b'), false, '写不进盘必须返 false,不能吞异常成功')
}))

test('saveTasks:写盘失败返 false(fail-closed),不抛', () => withDir((dataDir) => {
  writeFileSync(join(dataDir, 'memory'), 'occupied', 'utf-8')
  let logged = ''
  assert.equal(saveTasks(dataDir, { tasks: [], notified_blocked: [] }, (m) => { logged = m }), false)
  assert.match(logged, /写盘失败/)
}))

test('saveTasks:畸形 task(缺 steps)在 normalize 阶段抛也走 fail-closed,不逃出 return-false', () => withDir((dataDir) => {
  // 合法 JSON 但 task 缺字段 → absolutizeTaskTimes 的 steps.map 抛(reviewer r1 复现的洞)。
  // 修复前该 throw 逃出 try;修复后 normalize 在 try 内,应返 false 不抛。
  const malformed = { tasks: [{ id: 'task_x' } as unknown as Task], notified_blocked: [] }
  let result: boolean | undefined
  assert.doesNotThrow(() => { result = saveTasks(dataDir, malformed) })
  assert.equal(result, false)
}))

// ── markBlocked ────────────────────────────────────────────

test('markBlocked:转 blocked + 填 reason 落盘', () => withDir((dataDir) => {
  saveTasks(dataDir, { tasks: [mkTask({ id: 'task_c', status: 'in_progress' })], notified_blocked: [] })
  assert.equal(markBlocked(dataDir, 'task_c', '缺 API key'), true)
  const saved = loadTasks(dataDir).tasks[0]!
  assert.equal(saved.status, 'blocked')
  assert.equal(saved.blocked_reason, '缺 API key')
}))

test('markBlocked:已 done 的 task 不动,返 false', () => withDir((dataDir) => {
  saveTasks(dataDir, { tasks: [mkTask({ id: 'task_d', status: 'done' })], notified_blocked: [] })
  assert.equal(markBlocked(dataDir, 'task_d', 'x'), false)
  assert.equal(loadTasks(dataDir).tasks[0]!.status, 'done')
}))

// ── H1: 无进展检测(taskProgressSig + recordTaskProgress)────

test('taskProgressSig:next_step | 完成step数 | status', () => {
  const t = mkTask({
    next_step: '调研向量库', status: 'in_progress',
    steps: [{ id: 's1', text: 'a', status: 'done' }, { id: 's2', text: 'b', status: 'todo' }],
  })
  assert.equal(taskProgressSig(t), '调研向量库|1|in_progress')
})

test('recordTaskProgress:无进展(sig 不变)→ fail_streak++ 落盘', () => withDir((dataDir) => {
  const t = mkTask({ id: 'task_np', status: 'in_progress', next_step: '同一步', fail_streak: 0 })
  saveTasks(dataDir, { tasks: [t], notified_blocked: [] })
  const prevSig = taskProgressSig(t)
  recordTaskProgress(dataDir, 'task_np', prevSig)
  const after = loadTasks(dataDir).tasks[0]!
  assert.equal(after.fail_streak, 1, '没进展 fail_streak 从 0 涨到 1')
  assert.equal(after.status, 'in_progress', '还没到 3 次,不 block')
}))

test('recordTaskProgress:有进展(sig 变了)→ fail_streak 归 0 落盘', () => withDir((dataDir) => {
  // 跑前 next_step='旧';cycle 里改成了'新' → sig 变,fail_streak 应归 0
  const before = mkTask({ id: 'task_p', status: 'in_progress', next_step: '旧', fail_streak: 2 })
  const prevSig = taskProgressSig(before)
  const after = mkTask({ id: 'task_p', status: 'in_progress', next_step: '新', fail_streak: 2 })
  saveTasks(dataDir, { tasks: [after], notified_blocked: [] })
  recordTaskProgress(dataDir, 'task_p', prevSig)
  assert.equal(loadTasks(dataDir).tasks[0]!.fail_streak, 0, '有进展归 0')
}))

test('recordTaskProgress:fail_streak 升到 3 → 自动 markBlocked', () => withDir((dataDir) => {
  // fail_streak 已 2,这轮又没进展 → ++到 3 → shouldBlockForFailStreak → blocked
  const t = mkTask({ id: 'task_stuck', status: 'in_progress', next_step: '卡住', fail_streak: 2 })
  saveTasks(dataDir, { tasks: [t], notified_blocked: [] })
  recordTaskProgress(dataDir, 'task_stuck', taskProgressSig(t))
  const after = loadTasks(dataDir).tasks[0]!
  assert.equal(after.fail_streak, 3, 'fail_streak 落到 3')
  assert.equal(after.status, 'blocked', '达 3 次自动挂起')
  assert.match(after.blocked_reason!, /无进展/)
}))

test('recordTaskProgress:已 done/blocked 的 task 不动', () => withDir((dataDir) => {
  const done = mkTask({ id: 'task_done', status: 'done', fail_streak: 0 })
  saveTasks(dataDir, { tasks: [done], notified_blocked: [] })
  recordTaskProgress(dataDir, 'task_done', taskProgressSig(done))
  assert.equal(loadTasks(dataDir).tasks[0]!.fail_streak, 0, 'done 不碰')

  const blk = mkTask({ id: 'task_b', status: 'blocked', blocked_reason: 'x', fail_streak: 5 })
  saveTasks(dataDir, { tasks: [blk], notified_blocked: [] })
  recordTaskProgress(dataDir, 'task_b', taskProgressSig(blk))
  assert.equal(loadTasks(dataDir).tasks[0]!.fail_streak, 5, 'blocked 不碰')
}))

test('recordTaskProgress:找不到 task 不抛', () => withDir((dataDir) => {
  saveTasks(dataDir, { tasks: [], notified_blocked: [] })
  assert.doesNotThrow(() => recordTaskProgress(dataDir, 'task_nope', 'x|0|open'))
}))

// ── H2: wake_count 撞顶转 blocked + blocked 通知去重 ──────────

test('blockCappedTasks:open/in_progress 且 wake_count>=MAX → 转 blocked', () => withDir((dataDir) => {
  saveTasks(dataDir, {
    tasks: [
      mkTask({ id: 'capped', status: 'open', wake_count: MAX_WAKES_PER_TASK }),
      mkTask({ id: 'live', status: 'in_progress', wake_count: 1 }),
      mkTask({ id: 'done', status: 'done', wake_count: MAX_WAKES_PER_TASK }),
    ],
    notified_blocked: [],
  })
  const blocked = blockCappedTasks(dataDir)
  assert.deepEqual(blocked, ['capped'])
  const tasks = loadTasks(dataDir).tasks
  assert.equal(tasks.find(t => t.id === 'capped')!.status, 'blocked')
  assert.match(tasks.find(t => t.id === 'capped')!.blocked_reason!, /达上限/)
  assert.equal(tasks.find(t => t.id === 'live')!.status, 'in_progress', '没到顶不动')
  assert.equal(tasks.find(t => t.id === 'done')!.status, 'done', 'done 不动')
}))

test('pendingBlockedNotices:只返 blocked 且不在 notified_blocked 的', () => {
  const data = {
    tasks: [
      mkTask({ id: 'b1', status: 'blocked', blocked_reason: 'x' }),
      mkTask({ id: 'b2', status: 'blocked', blocked_reason: 'y' }),
      mkTask({ id: 'open', status: 'open' }),
    ],
    notified_blocked: ['b2'],
  }
  const pending = pendingBlockedNotices(data)
  assert.equal(pending.length, 1)
  assert.equal(pending[0]!.id, 'b1', 'b2 已 notified 排除,open 不是 blocked 排除')
})

test('formatBlockedNotices:空返空串;有则一行一个含 id/原因', () => {
  assert.equal(formatBlockedNotices([]), '')
  const text = formatBlockedNotices([mkTask({ id: 'b1', title: '调研', status: 'blocked', blocked_reason: '缺key' })])
  assert.match(text, /需要告知用户的挂起任务/)
  assert.match(text, /b1/)
  assert.match(text, /缺key/)
  assert.match(text, /message_send/)
})

test('addNotifiedBlocked:落盘去重(重复加不重复存)', () => withDir((dataDir) => {
  saveTasks(dataDir, { tasks: [mkTask({ id: 'b1', status: 'blocked', blocked_reason: 'x' })], notified_blocked: [] })
  assert.equal(addNotifiedBlocked(dataDir, 'b1'), true)
  assert.deepEqual(loadTasks(dataDir).notified_blocked, ['b1'])
  addNotifiedBlocked(dataDir, 'b1') // 再加一次
  assert.deepEqual(loadTasks(dataDir).notified_blocked, ['b1'], '不重复存')
}))

// ── 常量值锁定 ─────────────────────────────────────────────

test('有界常量值固定', () => {
  assert.equal(MAX_ACTIVE_TASKS, 3)
  assert.equal(MAX_WAKES_PER_TASK, 8)
  assert.equal(BACKOFF_BASE, 600)
})
