import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  taskCreateTool, taskListTool, taskUpdateTool, taskReviewTool, taskDeleteTool,
} from './task.js'
import type { ToolContext } from '../../core/types.js'
import type { ActiveTasksFile } from '../../memory/active-tasks.js'

// 临时 dataDir + 最小 ctx(saveTasks 会自建 memory 子目录)
function withDataDir(fn: (dataDir: string, ctx: ToolContext) => Promise<void>): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'mu-task-'))
  const ctx = { dataDir, log: () => {} } as unknown as ToolContext
  const cleanup = () => rmSync(dataDir, { recursive: true, force: true })
  return fn(dataDir, ctx).finally(cleanup)
}

function readFile(dataDir: string): ActiveTasksFile {
  const p = join(dataDir, 'memory', 'active-tasks.json')
  if (!existsSync(p)) return { tasks: [], notified_blocked: [] }
  return JSON.parse(readFileSync(p, 'utf-8')) as ActiveTasksFile
}

test('task_create:登记新任务,status=open 落盘', () => withDataDir(async (dataDir, ctx) => {
  const r = await taskCreateTool.execute({ title: '调研三个向量库', dod: '对比 LanceDB/Chroma/Milvus' }, ctx)
  assert.equal(r.success, true)
  const file = readFile(dataDir)
  assert.equal(file.tasks.length, 1)
  assert.equal(file.tasks[0]!.status, 'open')
  assert.equal(file.tasks[0]!.title, '调研三个向量库')
}))

test('task_create:title 空 → 拒绝', () => withDataDir(async (_dataDir, ctx) => {
  const r = await taskCreateTool.execute({ title: '   ' }, ctx)
  assert.equal(r.success, false)
  assert.ok(r.error?.includes('title'))
}))

test('task_create:活跃任务达 MAX_ACTIVE_TASKS=3 → 第 4 个被挡', () => withDataDir(async (_dataDir, ctx) => {
  for (let i = 1; i <= 3; i++) {
    const r = await taskCreateTool.execute({ title: `任务${i}` }, ctx)
    assert.equal(r.success, true)
  }
  const r4 = await taskCreateTool.execute({ title: '任务4' }, ctx)
  assert.equal(r4.success, false)
  assert.ok(r4.error?.includes('上限'))
}))

test('task_create:done/blocked 不计入活跃额度(腾出位子)', () => withDataDir(async (dataDir, ctx) => {
  await taskCreateTool.execute({ title: 'a' }, ctx)
  await taskCreateTool.execute({ title: 'b' }, ctx)
  const file = readFile(dataDir)
  const idA = file.tasks[0]!.id
  // 把 a 转 blocked(blocked 不算活跃)
  const rb = await taskUpdateTool.execute({ id: idA, status: 'blocked', blocked_reason: '等用户给资料' }, ctx)
  assert.equal(rb.success, true)
  // 现在活跃只剩 b 一个,还能再建两个到 3
  assert.equal((await taskCreateTool.execute({ title: 'c' }, ctx)).success, true)
  assert.equal((await taskCreateTool.execute({ title: 'd' }, ctx)).success, true)
}))

test('task_update:非法状态跳转被拒(open→done)', () => withDataDir(async (dataDir, ctx) => {
  await taskCreateTool.execute({ title: 'x', dod: '验收' }, ctx)
  const id = readFile(dataDir).tasks[0]!.id
  const r = await taskUpdateTool.execute({ id, status: 'done' }, ctx)
  assert.equal(r.success, false)
  assert.ok(r.error?.includes('非法状态跳转'))
}))

// 有 DoD 时置 done 走 reviewGate 自审。测试 ctx 无 config → reviewGate fail-open(放行),
// 自动补一条 by:'self' 的 pass review 满足 validateTransition 前置,done 成立。
// (validateTransition 自身的 done 前置在 active-tasks.test.ts 直接锁,这里锁 gate 的 fail-open 放行链路)
test('task_update:有 DoD 置 done → reviewGate fail-open 放行 + 自动补 self pass review', () => withDataDir(async (dataDir, ctx) => {
  await taskCreateTool.execute({ title: 'x', dod: '验收', steps: ['做完它'] }, ctx)
  const id = readFile(dataDir).tasks[0]!.id
  assert.equal((await taskUpdateTool.execute({ id, status: 'in_progress' }, ctx)).success, true)
  assert.equal((await taskUpdateTool.execute({ id, step_id: 's1', step_status: 'done' }, ctx)).success, true)
  assert.equal((await taskUpdateTool.execute({ id, status: 'in_review' }, ctx)).success, true)
  // in_review → done:gate fail-open 放行(无 config),done 成立
  const r = await taskUpdateTool.execute({ id, status: 'done' }, ctx)
  assert.equal(r.success, true)
  const t = readFile(dataDir).tasks[0]!
  assert.equal(t.status, 'done')
  const last = t.review[t.review.length - 1]!
  assert.equal(last.by, 'self', 'gate 补的是 self review')
  assert.equal(last.verdict, 'pass')
}))

test('task_review + task_update:pass review 后可置 done', () => withDataDir(async (dataDir, ctx) => {
  await taskCreateTool.execute({ title: 'x', dod: '验收', steps: ['做完它'] }, ctx)
  const id = readFile(dataDir).tasks[0]!.id
  await taskUpdateTool.execute({ id, status: 'in_progress' }, ctx)
  await taskUpdateTool.execute({ id, step_id: 's1', step_status: 'done' }, ctx)
  await taskUpdateTool.execute({ id, status: 'in_review' }, ctx)
  // 追加一条 pass review
  const rv = await taskReviewTool.execute({ id, verdict: 'pass', note: 'DoD 满足', by: 'master' }, ctx)
  assert.equal(rv.success, true)
  // 现在 in_review → done 放行
  const rd = await taskUpdateTool.execute({ id, status: 'done' }, ctx)
  assert.equal(rd.success, true)
  assert.equal(readFile(dataDir).tasks[0]!.status, 'done')
}))

// R7 端到端:task 已自审 1 轮(review_rounds=1),再置 done 撞上界 → reviewGate 强制放行,
// 不烧模型(短路在建 router 前),打 review_status:'failed' 留痕。
test('task_update:置 done 撞 2 轮自审上界 → 强制放行 + review_status=failed(R7)', () => withDataDir(async (dataDir, ctx) => {
  await taskCreateTool.execute({ title: 'x', dod: '验收', steps: ['做完它'] }, ctx)
  const id = readFile(dataDir).tasks[0]!.id
  await taskUpdateTool.execute({ id, status: 'in_progress' }, ctx)
  await taskUpdateTool.execute({ id, step_id: 's1', step_status: 'done' }, ctx)
  await taskUpdateTool.execute({ id, status: 'in_review' }, ctx)
  // 手动把 review_rounds 顶到 MAX-1=1(模拟前面已经被打回过一轮)
  {
    const f = readFile(dataDir)
    f.tasks[0]!.review_rounds = 1
    writeFileSync(join(dataDir, 'memory', 'active-tasks.json'), JSON.stringify(f, null, 2))
  }
  const r = await taskUpdateTool.execute({ id, status: 'done' }, ctx)
  assert.equal(r.success, true, '撞上界强制放行,done 成立')
  const t = readFile(dataDir).tasks[0]!
  assert.equal(t.status, 'done')
  assert.equal(t.review_status, 'failed', '强制放行打 failed 标记')
  assert.equal(t.review_rounds, 2, 'rounds 涨到上界')
}))

// 范围边界:无 DoD 的 task 走不到 done(validateTransition 卡 in_review),自然不过 review;
// 这条锁"无 DoD 不触发自审"——只有 DoD + done 才进 gate。
test('task_update:无 DoD 进 in_review 被卡(自审只在有 DoD 时介入)', () => withDataDir(async (dataDir, ctx) => {
  await taskCreateTool.execute({ title: 'x', steps: ['做完它'] }, ctx)
  const id = readFile(dataDir).tasks[0]!.id
  await taskUpdateTool.execute({ id, status: 'in_progress' }, ctx)
  await taskUpdateTool.execute({ id, step_id: 's1', step_status: 'done' }, ctx)
  const r = await taskUpdateTool.execute({ id, status: 'in_review' }, ctx)
  assert.equal(r.success, false)
  assert.ok(r.error?.includes('dod'))
}))

test('task_update:转 blocked 缺 reason 被拒', () => withDataDir(async (dataDir, ctx) => {
  await taskCreateTool.execute({ title: 'x' }, ctx)
  const id = readFile(dataDir).tasks[0]!.id
  const r = await taskUpdateTool.execute({ id, status: 'blocked' }, ctx)
  assert.equal(r.success, false)
  assert.ok(r.error?.includes('blocked_reason'))
}))

test('task_review:verdict 非 pass/fail 被拒', () => withDataDir(async (dataDir, ctx) => {
  await taskCreateTool.execute({ title: 'x' }, ctx)
  const id = readFile(dataDir).tasks[0]!.id
  const r = await taskReviewTool.execute({ id, verdict: 'maybe' }, ctx)
  assert.equal(r.success, false)
}))

test('task_list:只列活跃(done/blocked 不出现)', () => withDataDir(async (dataDir, ctx) => {
  await taskCreateTool.execute({ title: 'open 的' }, ctx)
  await taskCreateTool.execute({ title: 'blocked 的' }, ctx)
  const file = readFile(dataDir)
  const blockedId = file.tasks[1]!.id
  await taskUpdateTool.execute({ id: blockedId, status: 'blocked', blocked_reason: '卡了' }, ctx)
  const r = await taskListTool.execute({}, ctx)
  assert.equal(r.success, true)
  const list = JSON.parse(r.output) as { id: string; title: string }[]
  assert.equal(list.length, 1)
  assert.equal(list[0]!.title, 'open 的')
}))

test('task_delete:删除生效', () => withDataDir(async (dataDir, ctx) => {
  await taskCreateTool.execute({ title: '要删的' }, ctx)
  const id = readFile(dataDir).tasks[0]!.id
  const r = await taskDeleteTool.execute({ id }, ctx)
  assert.equal(r.success, true)
  assert.equal(readFile(dataDir).tasks.length, 0)
}))

test('task_delete:找不到 id 报错', () => withDataDir(async (_dataDir, ctx) => {
  const r = await taskDeleteTool.execute({ id: 'task_nope' }, ctx)
  assert.equal(r.success, false)
  assert.ok(r.error?.includes('找不到'))
}))
