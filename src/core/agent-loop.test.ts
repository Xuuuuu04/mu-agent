import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentLoop } from './agent-loop.js'
import { ToolRegistry } from '../tools/registry.js'
import type { MuConfig, WakeTrigger, ContentBlock, ToolDef, Task } from './types.js'
import type { ChatResponse } from '../providers/base.js'

// runCycle 集成测试:mock router/assembler,验证完整 cycle 流(含死亡螺旋相关的末轮回退)。
// 专业助理被动响应:不自动安排唤醒,也不解析 [WAKE]/[MOOD] 指令。

function minimalConfig(dataDir: string): MuConfig {
  return {
    model: { primary: { name: 'fake', format: 'openai', base_url: '', api_key: '', model: 'm', max_tokens: 4096 } },
    scheduler: { min_wake_seconds: 120, max_wake_seconds: 3600, max_sleep_seconds: 28800, cron_fallback_seconds: 900, night_min_wake_seconds: 1800, night_start_hour: 23, night_end_hour: 7 },
    agent: { max_turns_per_cycle: 10, session_timeout_minutes: 30 },
    paths: { soul: dataDir, data: dataDir, tools: join(dataDir, 'tools') },
  }
}

function res(content: ContentBlock[]): ChatResponse {
  return { id: 'r', content, stop_reason: 'end', usage: { input_tokens: 5, output_tokens: 3 } }
}
const textRes = (t: string) => res([{ type: 'text', text: t }])

// 脚本化 router:按队列依次返回,记录调用次数
function scriptedRouter(responses: ChatResponse[]) {
  let i = 0
  let calls = 0
  return {
    primaryName: 'fake',
    get calls() { return calls },
    chat: async () => { calls++; return responses[Math.min(i++, responses.length - 1)]! },
  }
}

// 记录 scheduleNext 的假 scheduler
function fakeScheduler() {
  const scheduled: Array<{ seconds: number; reason: string; activity_type: string }> = []
  return {
    scheduled,
    scheduleNext: (x: { seconds: number; reason: string; activity_type: string }) => { scheduled.push(x) },
    getStatus: (): { sleeping: boolean; nextWake: Date | null; reason: string } =>
      ({ sleeping: false, nextWake: null, reason: '' }),
  }
}

const fakeAssembler = () => ({
  assemble: async () => ({ system: [{ type: 'text', text: 'sys' }] as ContentBlock[] }),
  setLastUserContact() {},
  setLastWake() {},
  streamLayer: { append() {} },
})

function setup(responses: ChatResponse[], opts: { tool?: ToolDef; withStore?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mu-al-'))
  mkdirSync(join(dir, 'memory'), { recursive: true })
  const router = scriptedRouter(responses)
  const scheduler = fakeScheduler()
  const tools = new ToolRegistry()
  if (opts.tool) tools.register(opts.tool, { reserved: true })
  const loop = new AgentLoop({
    config: minimalConfig(dir),
    assembler: fakeAssembler() as never,
    router: router as never,
    tools,
    scheduler: scheduler as never,
  })
  return { loop, router, scheduler, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const userMsg = (text: string): WakeTrigger => ({
  type: 'message',
  message: { id: 'm1', source: 'webhook', chat_type: 'private', sender: { id: 'bro', name: 'x' }, content: { type: 'text', text }, timestamp: 0 },
})

const tick = () => new Promise<void>(r => setTimeout(r, 40))

test('简单文本 cycle:无工具,回复=模型文本', async () => {
  const s = setup([textRes('在的呀')])
  try {
    const r = await s.loop.runCycle(userMsg('在吗'))
    assert.equal(r.response, '在的呀')
    assert.equal(r.tool_calls_made, 0)
  } finally { s.cleanup() }
})

test('工具循环:tool_use 轮 → 执行 → 文本轮收尾', async () => {
  let executed = 0
  const echo: ToolDef = {
    name: 'echo', description: 'e', parameters: {},
    execute: async () => { executed++; return { success: true, output: 'ok' } },
  }
  const s = setup([
    res([{ type: 'tool_use', id: 't1', name: 'echo', input: {} }]),
    textRes('查到了'),
  ], { tool: echo })
  try {
    const r = await s.loop.runCycle(userMsg('查一下'))
    assert.equal(executed, 1)
    assert.equal(r.tool_calls_made, 1)
    assert.equal(r.response, '查到了')
  } finally { s.cleanup() }
})

test('末轮纯指令回退:正文不蒸发(06-10 已读不回根因)', async () => {
  const echo: ToolDef = { name: 'echo', description: 'e', parameters: {}, execute: async () => ({ success: true, output: 'ok' }) }
  const s = setup([
    res([{ type: 'text', text: '去机场坐大巴' }, { type: 'tool_use', id: 't1', name: 'echo', input: {} }]),
    textRes('[WAKE:300:歇会:rest]'),   // 末轮只有指令
  ], { tool: echo })
  try {
    const r = await s.loop.runCycle(userMsg('怎么去'))
    // 正文回退到上一轮实质内容,指令被清掉
    assert.equal(r.response, '去机场坐大巴')
  } finally { s.cleanup() }
})

test('命令拦截:/help 零 token、不调 router', async () => {
  // 命令路径需要 store+scheduler;用 :memory: store
  const { MemoryStore } = await import('../memory/store.js')
  const dir = mkdtempSync(join(tmpdir(), 'mu-al-'))
  mkdirSync(join(dir, 'memory'), { recursive: true })
  const router = scriptedRouter([textRes('不该被调用')])
  const tools = new ToolRegistry()
  const loop = new AgentLoop({
    config: minimalConfig(dir), assembler: fakeAssembler() as never, router: router as never,
    tools, scheduler: fakeScheduler() as never, store: new MemoryStore(':memory:'),
  })
  try {
    const r = await loop.runCycle(userMsg('/help'))
    assert.equal(r.tokens_used.input, 0)
    assert.equal(r.tool_calls_made, 0)
    assert.equal(router.calls, 0, 'router 未被调用')
    assert.ok(r.response.length > 0, '有帮助文本')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('postProcess:回复无 [WAKE] → 不自动安排唤醒(被动响应)', async () => {
  const s = setup([textRes('就随便聊聊')])
  try {
    await s.loop.runCycle(userMsg('嗨'))
    await tick()   // postProcess 是 fire-and-forget,等它跑完
    assert.equal(s.scheduler.scheduled.length, 0, '不再补默认唤醒')
  } finally { s.cleanup() }
})

test('postProcess:回复带 [WAKE:600] → 指令清掉但不据此调度', async () => {
  const s = setup([textRes('困了[WAKE:600:消化:rest]')])
  try {
    const r = await s.loop.runCycle(userMsg('晚安'))
    assert.equal(r.response, '困了')   // 指令仍从回复里清掉(cleanResponse)
    await tick()
    assert.ok(!s.scheduler.scheduled.some(x => x.seconds === 600), '不再按 [WAKE] 自动调度')
  } finally { s.cleanup() }
})

// ── Phase 2: 自主推进续唤醒(postProcess scheduleTaskContinuation)──

function mkTask(over: Partial<Task> = {}): Task {
  return {
    id: 'task_t1', title: 'T', dod: '', status: 'open',
    source: { channel: 'cli', raw: 'r', at: '2026-06-29T00:00:00.000Z' },
    steps: [], review: [], next_step: '', last_progress: '',
    wake_count: 0, fail_streak: 0, next_wake_at: null, blocked_reason: null,
    created: '2026-06-29', updated: '2026-06-29T00:00:00.000Z', ...over,
  }
}
function writeTasks(dir: string, tasks: Task[]): void {
  writeFileSync(join(dir, 'memory', 'active-tasks.json'), JSON.stringify({ tasks, notified_blocked: [] }), 'utf-8')
}
function readTasks(dir: string): Task[] {
  return JSON.parse(readFileSync(join(dir, 'memory', 'active-tasks.json'), 'utf-8')).tasks
}

// 关键断言(2.7):无 open task 时 postProcess 续唤醒分支不排任何唤醒,
// 行为与当前纯被动逐字节相同。这是"不复活无目的生活"的物理锚点。
test('empty-active-tasks 逐字节被动:无 open task → 不 scheduleNext', async () => {
  const s = setup([textRes('好的')])
  try {
    // 一种没有 active-tasks.json(纯被动默认),一种空 tasks 数组——两者都不该排唤醒
    await s.loop.runCycle(userMsg('在吗'))
    await tick()
    assert.equal(s.scheduler.scheduled.length, 0, '无文件时不排唤醒')

    writeTasks(s.dir, [])
    await s.loop.runCycle(userMsg('还在吗'))
    await tick()
    assert.equal(s.scheduler.scheduled.length, 0, '空 tasks 数组也不排唤醒')

    // 全 done/blocked 同样不可推进
    writeTasks(s.dir, [mkTask({ status: 'done' }), mkTask({ id: 'task_b', status: 'blocked' })])
    await s.loop.runCycle(userMsg('?'))
    await tick()
    assert.equal(s.scheduler.scheduled.length, 0, 'done/blocked 不排唤醒')
  } finally { s.cleanup() }
})

test('有 open task → cycle 成功后排 self_scheduled[task] 唤醒 + bumpWakeCount', async () => {
  const s = setup([textRes('记下了')])
  try {
    writeTasks(s.dir, [mkTask({ id: 'task_abc', wake_count: 1 })])
    await s.loop.runCycle(userMsg('帮我调研三个向量库'))
    await tick()
    assert.equal(s.scheduler.scheduled.length, 1, '排了一次续唤醒')
    const w = s.scheduler.scheduled[0]!
    assert.equal(w.activity_type, 'task')
    assert.match(w.reason, /task_abc/, 'reason 带 taskId,供 context-assembler 命中注入全文')
    // bumpWakeCount 在排唤醒时 +1(挂掉的 cycle 计数照涨,物理封顶)
    assert.equal(readTasks(s.dir)[0]!.wake_count, 2, 'wake_count 落盘 +1')
  } finally { s.cleanup() }
})

test('wake_count 到顶(MAX_WAKES_PER_TASK)→ pick 过滤,不再排', async () => {
  const s = setup([textRes('好')])
  try {
    writeTasks(s.dir, [mkTask({ id: 'task_max', wake_count: 8 })]) // MAX_WAKES_PER_TASK=8
    await s.loop.runCycle(userMsg('继续'))
    await tick()
    assert.equal(s.scheduler.scheduled.length, 0, '到 wake_count 上限不再续唤醒')
    assert.equal(readTasks(s.dir)[0]!.wake_count, 8, '没排就不 bump')
  } finally { s.cleanup() }
})

test('fail-closed:bumpWakeCount 写盘失败 → 不排续唤醒(cron 兜底接)', async () => {
  const s = setup([textRes('好')])
  try {
    writeTasks(s.dir, [mkTask({ id: 'task_ro' })])
    // 把 active-tasks.json 设只读:loadTasks(读)仍 OK,saveTasks/bumpWakeCount(写)失败返 false
    chmodSync(join(s.dir, 'memory', 'active-tasks.json'), 0o444)
    await s.loop.runCycle(userMsg('继续'))
    await tick()
    assert.equal(s.scheduler.scheduled.length, 0, '计数没落盘时不排唤醒')
  } finally {
    try { chmodSync(join(s.dir, 'memory', 'active-tasks.json'), 0o644) } catch { /* ignore */ }
    s.cleanup()
  }
})

// ── M3: task 续唤醒绝不覆盖用户提醒(只覆盖 pending 的 task 唤醒)──

test('M3:pending 是用户提醒(更晚)→ task 唤醒不覆盖', async () => {
  const s = setup([textRes('好')])
  try {
    // updated=现在 → task 续唤醒约 backoff(0)=600s 后;比 60s 后的用户提醒晚
    writeTasks(s.dir, [mkTask({ id: 'task_late', updated: new Date().toISOString() })])
    // 用户 schedule_wake 排了 60s 后的提醒(reason 不是 task 前缀)
    s.scheduler.getStatus = () => ({ sleeping: true, nextWake: new Date(Date.now() + 60_000), reason: '提醒哥哥喝水' })
    await s.loop.runCycle(userMsg('继续'))
    await tick()
    assert.equal(s.scheduler.scheduled.length, 0, '用户提醒在,task 不抢')
    assert.equal(readTasks(s.dir)[0]!.wake_count, 0, '没排 task 就不 bump')
  } finally { s.cleanup() }
})

test('M3:pending 是用户提醒(即使 task 唤醒更早)→ 仍不覆盖用户提醒(丢提醒 bug 的核心)', async () => {
  const s = setup([textRes('好')])
  try {
    // updated 在过去 → task 续唤醒已 overdue(0s),比 1 小时后的用户提醒早。
    // 但用户提醒(reason 非 task 前缀)绝不能被覆盖 —— 这次让位,下个 cycle 再重排 task。
    writeTasks(s.dir, [mkTask({ id: 'task_due' })])
    s.scheduler.getStatus = () => ({ sleeping: true, nextWake: new Date(Date.now() + 3600_000), reason: '远的用户提醒' })
    await s.loop.runCycle(userMsg('继续'))
    await tick()
    assert.equal(s.scheduler.scheduled.length, 0, 'task 更早也不抢用户提醒')
    assert.equal(readTasks(s.dir)[0]!.wake_count, 0, '没排 task 就不 bump')
  } finally { s.cleanup() }
})

test('M3:pending 是 task 唤醒 → 取最早(task 更早就重排,覆盖旧 task 唤醒)', async () => {
  const s = setup([textRes('好')])
  try {
    // task 续唤醒已 overdue(0s),比 1 小时后的旧 task 唤醒早 → 重排
    writeTasks(s.dir, [mkTask({ id: 'task_due' })])
    s.scheduler.getStatus = () => ({ sleeping: true, nextWake: new Date(Date.now() + 3600_000), reason: '推进任务 task_due' })
    await s.loop.runCycle(userMsg('继续'))
    await tick()
    assert.equal(s.scheduler.scheduled.length, 1, '旧的是 task 唤醒且更晚,取更早的重排')
    assert.equal(s.scheduler.scheduled[0]!.activity_type, 'task')
    assert.match(s.scheduler.scheduled[0]!.reason, /推进任务 task_due/)
    assert.equal(readTasks(s.dir)[0]!.wake_count, 1)
  } finally { s.cleanup() }
})

test('M3:pending 是 task 唤醒且更早 → 不重排(取最早)', async () => {
  const s = setup([textRes('好')])
  try {
    // task 续唤醒约 600s 后;已 pending 的 task 唤醒在 60s 后(更早)→ 不重排
    writeTasks(s.dir, [mkTask({ id: 'task_late', updated: new Date().toISOString() })])
    s.scheduler.getStatus = () => ({ sleeping: true, nextWake: new Date(Date.now() + 60_000), reason: '推进任务 task_late' })
    await s.loop.runCycle(userMsg('继续'))
    await tick()
    assert.equal(s.scheduler.scheduled.length, 0, '已排 task 唤醒更早,不重排')
    assert.equal(readTasks(s.dir)[0]!.wake_count, 0, '没排就不 bump')
  } finally { s.cleanup() }
})

// ── H1: task cycle 无进展检测 → fail_streak++ / ≥3 自动 blocked(整链接通)──

const taskTrigger = (taskId: string): WakeTrigger =>
  ({ type: 'self_scheduled', reason: `推进任务 ${taskId}`, activity_type: 'task' })

test('H1:task cycle 没动进度(模型只说话不改 task)→ fail_streak++', async () => {
  const s = setup([textRes('我看了看,还没头绪')])
  try {
    writeTasks(s.dir, [mkTask({ id: 'task_np', status: 'in_progress', next_step: '调研', fail_streak: 0 })])
    await s.loop.runCycle(taskTrigger('task_np'))
    await tick()
    // cycle 跑前后 progressSig 不变 → fail_streak 0→1
    assert.equal(readTasks(s.dir)[0]!.fail_streak, 1, '无进展 fail_streak++')
  } finally { s.cleanup() }
})

test('H1:连续无进展把 fail_streak 顶到 3 → 该 task 自动 blocked,且不再续唤醒', async () => {
  const s = setup([textRes('还是卡着')])
  try {
    // 起点 fail_streak=2,这轮又没进展 → 3 → 自动 blocked
    writeTasks(s.dir, [mkTask({ id: 'task_stuck', status: 'in_progress', next_step: '卡', fail_streak: 2 })])
    await s.loop.runCycle(taskTrigger('task_stuck'))
    await tick()
    const t = readTasks(s.dir)[0]!
    assert.equal(t.fail_streak, 3)
    assert.equal(t.status, 'blocked', '达 3 次自动挂起')
    assert.equal(s.scheduler.scheduled.length, 0, 'blocked 后 pick 不再选它,不续唤醒')
  } finally { s.cleanup() }
})

// ── H2: wake_count 撞顶 → 转 blocked(不再静默放弃)+ 一次性告知去重 ──

test('H2:wake_count 到顶的 task,成功 cycle 后转 blocked', async () => {
  const s = setup([textRes('好')])
  try {
    writeTasks(s.dir, [mkTask({ id: 'task_cap', status: 'open', wake_count: 8 })]) // MAX=8
    await s.loop.runCycle(userMsg('继续'))
    await tick()
    const t = readTasks(s.dir)[0]!
    assert.equal(t.status, 'blocked', '撞顶转 blocked')
    assert.match(t.blocked_reason!, /上限/)
    assert.equal(s.scheduler.scheduled.length, 0, 'blocked 不续唤醒')
  } finally { s.cleanup() }
})

test('H2:blocked task 被注入提示的 cycle 成功后 → 落 notified_blocked 去重', async () => {
  const s = setup([textRes('好')])
  try {
    // 已 blocked、未 notified;cycle 成功后应标记 notified,防下个 cycle 重复注入
    writeTasks(s.dir, [mkTask({ id: 'task_b', status: 'blocked', blocked_reason: 'x' })])
    await s.loop.runCycle(userMsg('在吗'))
    await tick()
    const data = JSON.parse(readFileSync(join(s.dir, 'memory', 'active-tasks.json'), 'utf-8'))
    assert.deepEqual(data.notified_blocked, ['task_b'], '成功 cycle 后落 notified 去重')
  } finally { s.cleanup() }
})

test('失败 cycle 不进续唤醒分支(R5:postProcess 只在成功路径调)', async () => {
  // router 抛错 → cycle 失败走 catch、throw,不调 postProcess
  const dir = mkdtempSync(join(tmpdir(), 'mu-al-'))
  mkdirSync(join(dir, 'memory'), { recursive: true })
  writeTasks(dir, [mkTask({ id: 'task_x' })])
  const scheduler = fakeScheduler()
  const loop = new AgentLoop({
    config: minimalConfig(dir),
    assembler: fakeAssembler() as never,
    router: { primaryName: 'fake', chat: async () => { throw new Error('boom') } } as never,
    tools: new ToolRegistry(),
    scheduler: scheduler as never,
  })
  try {
    await assert.rejects(() => loop.runCycle(userMsg('继续')), /boom/)
    await tick()
    assert.equal(scheduler.scheduled.length, 0, '失败 cycle 不排续唤醒')
    assert.equal(readTasks(dir)[0]!.wake_count, 0, '失败 cycle 不 bump')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
