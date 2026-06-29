// Task 存储 + 状态机校验 + 自主循环的物理封顶纯函数。
// 状态文件 data/memory/active-tasks.json:{ tasks: Task[], notified_blocked: string[] }。
// 这期只做地基,不接进任何 cycle —— 读写 + 校验 + 纯函数 + 单测,系统行为逐字节不变。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Task, TaskStatus } from '../core/types.js'
import { absolutizeTime } from './absolutize.js'

// ── 有界控制常量(防自主循环失控,模型改不动)──
export const MAX_ACTIVE_TASKS = 3
export const MAX_WAKES_PER_TASK = 8
export const BACKOFF_BASE = 600 // 秒

export interface ActiveTasksFile {
  tasks: Task[]
  notified_blocked: string[]
}

const EMPTY: ActiveTasksFile = { tasks: [], notified_blocked: [] }

function tasksPath(dataDir: string): string {
  return join(dataDir, 'memory', 'active-tasks.json')
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

// 文件不存在→空结构;读坏→不抛崩,返空 + log
export function loadTasks(dataDir: string, log: (msg: string) => void = () => {}): ActiveTasksFile {
  const path = tasksPath(dataDir)
  if (!existsSync(path)) return { tasks: [], notified_blocked: [] }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ActiveTasksFile>
    return {
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      notified_blocked: Array.isArray(parsed.notified_blocked) ? parsed.notified_blocked : [],
    }
  } catch (e) {
    log(`[active-tasks] 状态文件读坏,按空处理: ${(e as Error).message}`)
    return { tasks: [], notified_blocked: [] }
  }
}

// 写盘前对所有含时间语义的字段过 absolutizeTime(对标记忆系统"禁止相对时间")。
// 写失败返 false(fail-closed),不吞异常成功。
export function saveTasks(dataDir: string, data: ActiveTasksFile, log: (msg: string) => void = () => {}): boolean {
  const path = tasksPath(dataDir)
  try {
    // normalize 放进 try:畸形 task(过得了 loadTasks 但缺字段)在 .map 阶段抛也走 fail-closed,
    // 不逃出 return-false 保证(reviewer r1 复现的洞)。
    const normalized: ActiveTasksFile = {
      tasks: data.tasks.map(absolutizeTaskTimes),
      notified_blocked: data.notified_blocked,
    }
    ensureDir(path)
    writeFileSync(path, JSON.stringify(normalized, null, 2), 'utf-8')
    return true
  } catch (e) {
    log(`[active-tasks] 写盘失败: ${(e as Error).message}`)
    return false
  }
}

// 含时间语义的字段(title/dod/steps[].text/next_step/due)固化成绝对日期
export function absolutizeTaskTimes(task: Task): Task {
  return {
    ...task,
    title: absolutizeTime(task.title),
    dod: absolutizeTime(task.dod),
    next_step: absolutizeTime(task.next_step),
    due: task.due ? absolutizeTime(task.due) : task.due,
    steps: task.steps.map(s => ({ ...s, text: absolutizeTime(s.text) })),
  }
}

// ── 状态机校验(非法跳转返回 error,不抛)──
// open→in_progress→in_review→done;review fail 回 in_progress;任意非 done→blocked→回原状态。
const ALLOWED: Record<TaskStatus, TaskStatus[]> = {
  open: ['in_progress', 'blocked'],
  in_progress: ['in_review', 'blocked'],
  in_review: ['done', 'in_progress', 'blocked'], // review pass→done;fail→回 in_progress
  blocked: ['open', 'in_progress', 'in_review'], // unblock 回之前状态(done 不会被 block)
  done: [],
}

export interface TransitionResult {
  ok: boolean
  error?: string
}

// 校验一次状态跳转是否合法。force 跳过"进 in_review 的 steps 全 done"前置(dod 非空仍要)。
export function validateTransition(task: Task, to: TaskStatus, opts: { force?: boolean } = {}): TransitionResult {
  const from = task.status
  if (from === to) return { ok: true }
  if (!ALLOWED[from].includes(to)) {
    return { ok: false, error: `非法状态跳转: ${from} → ${to}` }
  }
  // 进 in_review 前置:dod 非空 且 steps 全 done(或显式 force)
  if (to === 'in_review') {
    if (!task.dod.trim()) return { ok: false, error: '进 in_review 前必须先补 dod(验收标准)' }
    if (!opts.force) {
      const allDone = task.steps.every(s => s.status === 'done')
      if (!allDone) return { ok: false, error: 'steps 未全部完成,不能进 in_review(可 force)' }
    }
  }
  // 进 blocked 前置:blocked_reason 必填
  if (to === 'blocked' && !(task.blocked_reason && task.blocked_reason.trim())) {
    return { ok: false, error: 'blocked 必须填 blocked_reason' }
  }
  // 置 done 前置:review[last].verdict==='pass'
  if (to === 'done') {
    const last = task.review[task.review.length - 1]
    if (!last || last.verdict !== 'pass') {
      return { ok: false, error: '置 done 前最后一条 review 的 verdict 必须是 pass' }
    }
  }
  return { ok: true }
}

// ── 自主循环的物理封顶纯函数(逻辑必须和设计 §3.3 一致)──

// backoff 间隔(秒):600 * 2^min(fail_streak, 4),封顶 9600s
export function backoffSeconds(failStreak: number): number {
  const exp = Math.min(Math.max(failStreak, 0), 4)
  return BACKOFF_BASE * 2 ** exp
}

// 单个 task 的下次自唤醒绝对时刻 = updated + backoff(fail_streak)
function computeWakeAt(task: Task, now: number): number {
  const base = Date.parse(task.updated)
  const anchor = Number.isNaN(base) ? now : base
  return anchor + backoffSeconds(task.fail_streak) * 1000
}

// 过滤可推进的 task(open/in_progress 且 wake_count<MAX),按 backoff 算各自 next_wake_at,
// 取最早的返回 {taskId, wakeAt};没有符合的返回 null。纯函数,不读全局不写盘。
export function pickNextWakeFromTasks(
  tasks: Task[], now: number,
): { taskId: string; wakeAt: string } | null {
  let best: { taskId: string; wakeAt: number } | null = null
  for (const t of tasks) {
    if (t.status !== 'open' && t.status !== 'in_progress') continue
    if (t.wake_count >= MAX_WAKES_PER_TASK) continue
    const wakeAt = computeWakeAt(t, now)
    if (!best || wakeAt < best.wakeAt) best = { taskId: t.id, wakeAt }
  }
  if (!best) return null
  return { taskId: best.taskId, wakeAt: new Date(best.wakeAt).toISOString() }
}

// wake_count +1 落盘。写盘失败返 false(fail-closed,调用方据此不排唤醒)。
export function bumpWakeCount(dataDir: string, taskId: string, log: (msg: string) => void = () => {}): boolean {
  const data = loadTasks(dataDir, log)
  const target = data.tasks.find(t => t.id === taskId)
  if (!target) {
    log(`[active-tasks] bumpWakeCount 找不到 task ${taskId}`)
    return false
  }
  target.wake_count += 1
  target.updated = new Date().toISOString()
  return saveTasks(dataDir, data, log)
}

// 转 blocked + 填 reason 落盘。写盘失败返 false。
export function markBlocked(dataDir: string, taskId: string, reason: string, log: (msg: string) => void = () => {}): boolean {
  const data = loadTasks(dataDir, log)
  const target = data.tasks.find(t => t.id === taskId)
  if (!target) {
    log(`[active-tasks] markBlocked 找不到 task ${taskId}`)
    return false
  }
  if (target.status === 'done') {
    log(`[active-tasks] markBlocked 跳过已 done 的 task ${taskId}`)
    return false
  }
  target.status = 'blocked'
  target.blocked_reason = reason
  target.updated = new Date().toISOString()
  return saveTasks(dataDir, data, log)
}

// fail_streak>=3 时该 task 应被 blocked。供调用方在更新进度后判断。
export function shouldBlockForFailStreak(task: Task): boolean {
  return task.fail_streak >= 3
}

// 进展指纹:next_step | 完成 step 数 | status。task cycle 跑前后比对,不变=无进展。
export function taskProgressSig(task: Task): string {
  const doneSteps = task.steps.filter(s => s.status === 'done').length
  return `${task.next_step}|${doneSteps}|${task.status}`
}

// task cycle 成功后调:reload 该 task,与 cycle 跑前的 prevSig 比对。
// 无进展(sig 不变)→ fail_streak++ 落盘,达 3 次→ markBlocked;有进展→ fail_streak 归 0。
// fail-safe:找不到/已 done/已 blocked 直接 return;写盘交给 saveTasks/markBlocked(fail-closed)。
// 红线:只在成功路径调,不抛(异常会冒泡进 postProcess 的 .catch,不影响 cycle)。
export function recordTaskProgress(
  dataDir: string, taskId: string, prevSig: string, log: (msg: string) => void = () => {},
): void {
  const data = loadTasks(dataDir, log)
  const target = data.tasks.find(t => t.id === taskId)
  if (!target || target.status === 'done' || target.status === 'blocked') return

  if (taskProgressSig(target) === prevSig) {
    target.fail_streak += 1
    target.updated = new Date().toISOString()
    if (shouldBlockForFailStreak(target)) {
      // markBlocked 自己 reload+落盘:先存 fail_streak++ 再 markBlocked,保证退避翻倍也落了盘
      saveTasks(dataDir, data, log)
      markBlocked(dataDir, taskId, '连续3次无进展,自动挂起待人工', log)
      return
    }
  } else if (target.fail_streak !== 0) {
    target.fail_streak = 0
    target.updated = new Date().toISOString()
  } else {
    return // 有进展且 fail_streak 本就是 0,无需写盘
  }
  saveTasks(dataDir, data, log)
}

// wake_count 撞上限的 open/in_progress task 转 blocked(否则只是 pick 不再选它、status 没转)。
// 返回被 block 的 taskId 列表。成功路径调,markBlocked 自身 fail-closed。
export function blockCappedTasks(dataDir: string, log: (msg: string) => void = () => {}): string[] {
  const { tasks } = loadTasks(dataDir, log)
  const capped = tasks.filter(t => isOpenLike(t) && t.wake_count >= MAX_WAKES_PER_TASK)
  const blocked: string[] = []
  for (const t of capped) {
    if (markBlocked(dataDir, t.id, '自主推进达上限,挂起待人工', log)) blocked.push(t.id)
  }
  return blocked
}

// ── 上下文注入用的纯格式化(context-assembler 按 trigger 分流调用)──

// "活跃" = open/in_progress(能被自唤醒推进的口径,与 pickNextWakeFromTasks 一致)
export function isOpenLike(t: Task): boolean {
  return t.status === 'open' || t.status === 'in_progress'
}

// 单个 task 全文:self_scheduled 续唤醒推一个 task 时注入,让她接着干这一个。
export function formatTaskFull(task: Task): string {
  const lines = [
    '--- 当前要推进的任务 ---',
    `[${task.id}] ${task.title}`,
    `状态: ${task.status}`,
    `验收标准(DoD): ${task.dod || '(待补)'}`,
  ]
  if (task.steps.length > 0) {
    lines.push('步骤:')
    for (const s of task.steps) lines.push(`  - [${s.status}] ${s.text}`)
  }
  lines.push(`下一步: ${task.next_step || '(还没定,先想清楚这一步做什么)'}`)
  if (task.last_progress) lines.push(`上次进展: ${task.last_progress}`)
  if (task.deliverable) lines.push(`产出物: ${task.deliverable}`)
  lines.push('推进这一步,做完更新进度(task_update);完成或卡住才找用户。')
  return lines.join('\n')
}

// 全部 open/in_progress task 的一行摘要:cron_fallback 兜底唤醒时注入(她自己挑哪个推)。
// 没有可推进的 task 返回空串(调用方据此不注入,退回纯被动)。
export function formatOpenTasksSummary(tasks: Task[]): string {
  const open = tasks.filter(isOpenLike)
  if (open.length === 0) return ''
  const lines = ['--- 进行中的任务 ---']
  for (const t of open) {
    lines.push(`[${t.id}] ${t.title}(${t.status})— 下一步: ${t.next_step || '待定'}`)
  }
  return lines.join('\n')
}

// 活跃任务条数:message 触发只注入一行"你有 N 个进行中任务",省 token。
export function countOpenTasks(tasks: Task[]): number {
  return tasks.filter(isOpenLike).length
}

// ── 升级去重(notified_blocked):同一 blocked task 只告知用户一次 ──
export function hasNotifiedBlocked(data: ActiveTasksFile, taskId: string): boolean {
  return data.notified_blocked.includes(taskId)
}

// 记下"已告知用户该 task blocked"并落盘。写盘失败返 false。
export function addNotifiedBlocked(dataDir: string, taskId: string, log: (msg: string) => void = () => {}): boolean {
  const data = loadTasks(dataDir, log)
  if (!data.notified_blocked.includes(taskId)) data.notified_blocked.push(taskId)
  return saveTasks(dataDir, data, log)
}

// 已 blocked 但还没告知用户的 task(notified_blocked 去重)。context-assembler 注入用。
export function pendingBlockedNotices(data: ActiveTasksFile): Task[] {
  return data.tasks.filter(t => t.status === 'blocked' && !hasNotifiedBlocked(data, t.id))
}

// 一次性 blocked 告知文案:让 Shion 用 message_send 主动告诉用户一次(放弃也要交付)。
// 没有待告知的返回空串(调用方据此不注入)。
export function formatBlockedNotices(tasks: Task[]): string {
  if (tasks.length === 0) return ''
  const lines = ['--- 需要告知用户的挂起任务 ---']
  for (const t of tasks) {
    lines.push(`任务 [${t.id}] ${t.title} 已自动挂起(原因: ${t.blocked_reason || '未知'})。请用 message_send 告知用户一次。`)
  }
  return lines.join('\n')
}
