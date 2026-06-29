// Task 工具:登记/查看/更新/审/删多步骤可 review 的任务。
// 全部薄封装 src/memory/active-tasks.ts —— 不在这里重复实现状态机/存储/封顶。
// 工具失败一律返 {success:false, error},绝不 try/catch 吞异常(吞了会让 3 连败自愈失效)。
import type {
  ToolDef, Task, TaskStatus, TaskStepStatus, TaskReview, ReviewVerdict,
} from '../../core/types.js'
import { loadTasks, saveTasks, validateTransition, MAX_ACTIVE_TASKS } from '../../memory/active-tasks.js'
import { reviewGate } from '../../core/self-review.js'

// task_<base36 时间>_<随机> —— 单纯 Date.now() 在同毫秒连建会撞 id,补随机后缀保唯一
function newTaskId(): string {
  return `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

// 活跃 = 非 done 非 blocked(挡 MAX_ACTIVE_TASKS 用这个口径)
function isActive(t: Task): boolean {
  return t.status !== 'done' && t.status !== 'blocked'
}

// 列表/详情统一的精简视图(给模型和命令/接口看)
function summarize(t: Task): Record<string, unknown> {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    next_step: t.next_step,
    dod: t.dod,
  }
}

export const taskCreateTool: ToolDef = {
  name: 'task_create',
  description: '登记一个多步骤、需要跨时间完成的任务。用户明确安排的、要分几步做的事用这个(随口闲聊/一次性问答不要建)。活跃任务最多 3 个,超了会拒绝',
  parameters: {
    title: { type: 'string', description: '任务标题(一句话说清要做什么)' },
    dod: { type: 'string', description: '完成定义/验收标准。没有就先标"待补"', required: false as unknown as string },
    steps: { type: 'array', items: { type: 'string' }, description: '拆解的步骤(可选,字符串数组)', required: false as unknown as string },
    due: { type: 'string', description: '截止日期 YYYY-MM-DD(可选)', required: false as unknown as string },
    source_raw: { type: 'string', description: '用户原话(可选,留档)', required: false as unknown as string },
  },
  requiredKeys: ['title'],
  async execute(params, ctx) {
    const title = String(params.title ?? '').trim()
    if (!title) return { success: false, output: '', error: 'title 不能为空' }

    const data = loadTasks(ctx.dataDir, ctx.log)
    const activeCount = data.tasks.filter(isActive).length
    if (activeCount >= MAX_ACTIVE_TASKS) {
      return { success: false, output: '', error: `活跃任务已达上限 ${MAX_ACTIVE_TASKS} 个,先完成或删掉一个再建` }
    }

    const now = new Date()
    const rawSteps = Array.isArray(params.steps) ? (params.steps as unknown[]) : []
    const steps = rawSteps
      .map(s => String(s ?? '').trim())
      .filter(s => s.length > 0)
      .map((text, i) => ({ id: `s${i + 1}`, text, status: 'todo' as TaskStepStatus }))

    const task: Task = {
      id: newTaskId(),
      title,
      dod: String(params.dod ?? '').trim(),
      status: 'open',
      source: {
        channel: 'cli',
        raw: String(params.source_raw ?? title),
        at: now.toISOString(),
      },
      steps,
      review: [],
      next_step: '',
      last_progress: '',
      wake_count: 0,
      fail_streak: 0,
      next_wake_at: null,
      blocked_reason: null,
      created: now.toISOString().slice(0, 10),
      updated: now.toISOString(),
      due: params.due ? String(params.due) : undefined,
    }

    data.tasks.push(task)
    if (!saveTasks(ctx.dataDir, data, ctx.log)) {
      return { success: false, output: '', error: '写盘失败,任务没存上' }
    }
    ctx.log(`新任务: ${task.id} ${task.title}`)
    return { success: true, output: `登记了任务 ${task.id}: ${task.title}` }
  },
}

export const taskListTool: ToolDef = {
  name: 'task_list',
  description: '列出当前活跃的任务(open/in_progress/in_review),看看有哪些事在跟进',
  parameters: {},
  async execute(_params, ctx) {
    const data = loadTasks(ctx.dataDir, ctx.log)
    const active = data.tasks.filter(isActive).map(summarize)
    return { success: true, output: JSON.stringify(active) }
  },
}

export const taskUpdateTool: ToolDef = {
  name: 'task_update',
  description: '更新一个任务:改状态(走状态机校验)、改某一步的状态、更新下一步/进展/产出物/卡住原因。置 done 要求最后一条 review 的 verdict 是 pass',
  parameters: {
    id: { type: 'string', description: '任务 ID' },
    status: { type: 'string', description: '新状态: open/in_progress/in_review/blocked/done(可选,非法跳转会被拒)', required: false as unknown as string },
    step_id: { type: 'string', description: '要改状态的步骤 id(配合 step_status,可选)', required: false as unknown as string },
    step_status: { type: 'string', description: '步骤新状态: todo/doing/done(配合 step_id,可选)', required: false as unknown as string },
    next_step: { type: 'string', description: '下一步干什么(可选)', required: false as unknown as string },
    last_progress: { type: 'string', description: '当前进展,给下次接手当上下文(可选)', required: false as unknown as string },
    deliverable: { type: 'string', description: '产出物:文件路径/链接/结论(可选)', required: false as unknown as string },
    blocked_reason: { type: 'string', description: '卡住原因(转 blocked 时必填)', required: false as unknown as string },
  },
  requiredKeys: ['id'],
  async execute(params, ctx) {
    const id = String(params.id ?? '')
    const data = loadTasks(ctx.dataDir, ctx.log)
    const task = data.tasks.find(t => t.id === id)
    if (!task) return { success: false, output: '', error: `找不到任务 ${id}` }

    // 先落非状态字段(blocked_reason 要在校验前写上,validateTransition 才看得到)
    if (typeof params.next_step === 'string') task.next_step = params.next_step
    if (typeof params.last_progress === 'string') task.last_progress = params.last_progress
    if (typeof params.deliverable === 'string') task.deliverable = params.deliverable
    if (typeof params.blocked_reason === 'string') task.blocked_reason = params.blocked_reason

    // 改某一步状态
    if (params.step_id !== undefined || params.step_status !== undefined) {
      const stepId = String(params.step_id ?? '')
      const stepStatus = String(params.step_status ?? '')
      const step = task.steps.find(s => s.id === stepId)
      if (!step) return { success: false, output: '', error: `找不到步骤 ${stepId}` }
      if (!['todo', 'doing', 'done'].includes(stepStatus)) {
        return { success: false, output: '', error: `步骤状态非法: ${stepStatus}` }
      }
      step.status = stepStatus as TaskStepStatus
    }

    // 状态跳转走状态机校验
    if (params.status !== undefined) {
      const to = String(params.status) as TaskStatus

      // 置 done 前自审(reviewGate):有 DoD 才审。pass→补一条 by:'self' 的 pass review
      // 满足 validateTransition 的 done 前置;fail→不置 done,返意见 + review_rounds++;
      // 撞 2 轮上界→强制放行 + 打 review_status:'failed'。
      // reviewGate fail-open 且绝不抛(R6),不进 sessionHistory。
      if (to === 'done' && task.dod.trim()) {
        const output = task.deliverable || task.last_progress || ''
        const gate = await reviewGate(task.dod, output, task.review_rounds ?? 0, ctx.config, ctx.log)
        task.review_rounds = gate.rounds
        if (!gate.passed) {
          // 没过且没强制放行 → 不置 done,把意见返给模型,保存涨上去的 review_rounds
          task.updated = new Date().toISOString()
          saveTasks(ctx.dataDir, data, ctx.log)
          return { success: false, output: '', error: `自审未过: ${gate.note},请改进后再标完成` }
        }
        if (gate.forced) task.review_status = 'failed'
        // 放行:补一条 self pass review(满足置 done 前置)
        task.review.push({
          at: new Date().toISOString(),
          verdict: 'pass',
          note: gate.note,
          by: 'self',
        })
      }

      const check = validateTransition(task, to)
      if (!check.ok) return { success: false, output: '', error: check.error }
      task.status = to
    }

    task.updated = new Date().toISOString()
    if (!saveTasks(ctx.dataDir, data, ctx.log)) {
      return { success: false, output: '', error: '写盘失败,更新没保存' }
    }
    return { success: true, output: `更新了任务 ${task.id}(状态 ${task.status})` }
  },
}

export const taskReviewTool: ToolDef = {
  name: 'task_review',
  description: '给任务追加一条 review。verdict=pass 才解锁 done;by=master 是用户拍板,by=self 留给自审',
  parameters: {
    id: { type: 'string', description: '任务 ID' },
    verdict: { type: 'string', description: 'pass(通过) 或 fail(不通过)' },
    note: { type: 'string', description: '哪条 DoD 没满足 / 为什么过', required: false as unknown as string },
    by: { type: 'string', description: 'master(用户拍板) 或 self(自审),默认 master', required: false as unknown as string },
    scores: { type: 'object', description: '多维打分(可选)', required: false as unknown as string },
  },
  requiredKeys: ['id', 'verdict'],
  async execute(params, ctx) {
    const id = String(params.id ?? '')
    const verdict = String(params.verdict ?? '')
    if (verdict !== 'pass' && verdict !== 'fail') {
      return { success: false, output: '', error: `verdict 只能是 pass 或 fail,收到: ${verdict}` }
    }
    const by = params.by === 'self' ? 'self' : 'master'

    const data = loadTasks(ctx.dataDir, ctx.log)
    const task = data.tasks.find(t => t.id === id)
    if (!task) return { success: false, output: '', error: `找不到任务 ${id}` }

    const review: TaskReview = {
      at: new Date().toISOString(),
      verdict: verdict as ReviewVerdict,
      note: String(params.note ?? ''),
      by,
      scores: (params.scores && typeof params.scores === 'object')
        ? (params.scores as Record<string, number>)
        : undefined,
    }
    task.review.push(review)
    task.updated = review.at
    if (!saveTasks(ctx.dataDir, data, ctx.log)) {
      return { success: false, output: '', error: '写盘失败,review 没保存' }
    }
    return { success: true, output: `任务 ${task.id} 已记一条 review: ${verdict}` }
  },
}

export const taskDeleteTool: ToolDef = {
  name: 'task_delete',
  description: '删除一个任务(= 取消)。用户说这事不用做了/取消了用这个',
  parameters: {
    id: { type: 'string', description: '任务 ID' },
  },
  requiredKeys: ['id'],
  async execute(params, ctx) {
    const id = String(params.id ?? '')
    const data = loadTasks(ctx.dataDir, ctx.log)
    const idx = data.tasks.findIndex(t => t.id === id)
    if (idx < 0) return { success: false, output: '', error: `找不到任务 ${id}` }

    const [removed] = data.tasks.splice(idx, 1)
    data.notified_blocked = data.notified_blocked.filter(x => x !== id)
    if (!saveTasks(ctx.dataDir, data, ctx.log)) {
      return { success: false, output: '', error: '写盘失败,任务没删掉' }
    }
    ctx.log(`删了任务: ${id}`)
    return { success: true, output: `删了任务 ${id}: ${removed?.title ?? ''}` }
  },
}
