import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryStore } from '../memory/store.js'
import type { Scheduler } from './scheduler.js'
import type { Commitment, MoodState, Position } from './types.js'
import { relativeTime } from '../memory/layers/temporal.js'
import { loadTasks } from '../memory/active-tasks.js'
import { approveShellRequest, rejectShellRequest } from '../tools/builtin/shell.js'

export interface CommandDeps {
  dataDir: string
  store: MemoryStore
  scheduler: Scheduler
  clearSession: () => void
  uptimeSeconds: () => number
}

// 命令判断单独导出:mu.ts 入队前用它决定要不要打断沐的闹钟。
// 命令是发给系统的(查状态/清会话),不是哥哥来说话,不该偷走她定好的"下次醒来"
// (06-10 上午 12 条命令消息清掉闹钟又不重设,她睡过了头)
export function isCommandText(text: string): boolean {
  return (text || '').trim().replace(/^／/, '/').startsWith('/')
}

// 拦截 / 命令。是命令就直接读记忆系统返回结果(不走 LLM);不是命令返回 null。
// 命令对应六层记忆的不同层:/new 清 L2 会话但保留 L3/L4 长期记忆,/todo 读 L3 承诺,等。
export function tryCommand(text: string, deps: CommandDeps): string | null {
  // 全角"／"也认(手机输入法常见,曾有"/new"透传进 LLM 让沐一脸懵的穿帮)
  const t = (text || '').trim().replace(/^／/, '/')
  if (!t.startsWith('/')) return null

  const parts = t.slice(1).split(/\s+/)
  const cmd = (parts[0] || '').toLowerCase()

  switch (cmd) {
    case 'help': case '?':
      return helpText()
    case 'new': case 'clear':
      deps.clearSession()
      return '当前会话已清空；长期记忆保留。'
    case 'status': case 's':
      return statusText(deps)
    case 'mood':
      return moodText(deps)
    case 'todo': case 'commitments':
      return todoText(deps)
    case '持仓': case 'portfolio': case 'gp':
      return portfolioText(deps)
    case '盯盘': case 'watchdog':
      return watchdogText(deps)
    case 'tasks': case 'task':
      return tasksText(deps)
    case 'memory': case 'mem':
      return memoryText(deps, parts.slice(1).join(' '))
    case 'approve-shell':
      return approveShellRequest(parts[1] ?? '')
    case 'reject-shell':
      return rejectShellRequest(parts[1] ?? '')
    default:
      return '未知命令。发送 /help 查看可用命令。'
  }
}

function helpText(): string {
  return [
    '可用命令:',
    '/new 或 /clear — 清空这轮对话(长期记忆保留)',
    '/status — 看我的状态(心情/记忆/下次醒)',
    '/mood — 我现在什么心情',
    '/todo — 答应你的事都在这',
    '/持仓 — 当前真实持仓(止损止盈)',
    '/盯盘 — watchdog 状态 + 最近告警',
    '/tasks — 正在跟进的任务',
    '/memory 关键词 — 翻翻我记得的事',
    '/approve-shell ID — 批准一条待执行的高风险 Shell 命令',
    '/reject-shell ID — 拒绝一条待执行的 Shell 命令',
    '/help — 就是这个',
  ].join('\n')
}

function statusText(deps: CommandDeps): string {
  const mood = loadMood(deps.dataDir)
  const lines: string[] = []
  lines.push(`心情: ${mood?.current ?? 'calm'}${mood?.reason ? ` — ${mood.reason}` : ''}`)
  lines.push(`记忆: ${deps.store.getEpisodeCount()} 条`)
  lines.push(`已经醒着: ${fmtDuration(deps.uptimeSeconds())}`)
  const tok = deps.store.getTodayTokenUsage()
  if (tok.calls > 0) {
    lines.push(`今天动了 ${tok.calls} 次脑子 (${Math.round(tok.input / 1000)}k+${Math.round(tok.output / 1000)}k)`)
  }
  const todoCount = activeCommitments(deps.dataDir).length
  if (todoCount > 0) lines.push(`待办: ${todoCount} 件`)
  const sched = deps.scheduler.getStatus()
  if (sched.sleeping && sched.nextWake) {
    const secs = Math.round((sched.nextWake.getTime() - Date.now()) / 1000)
    lines.push(`下次自己醒: ${fmtDuration(secs)}后 (${sched.reason})`)
  }
  return lines.join('\n')
}

function moodText(deps: CommandDeps): string {
  const mood = loadMood(deps.dataDir)
  if (!mood) return '现在挺平静的 calm'
  const since = new Date(mood.since)
  let s = `现在 ${mood.current}${mood.reason ? ` — ${mood.reason}` : ''}\n(${relativeTime(since, new Date())}变成这样的`
  if (mood.previous) s += `,之前是 ${mood.previous.mood}`
  s += ')'
  return s
}

function todoText(deps: CommandDeps): string {
  const cs = activeCommitments(deps.dataDir)
  if (cs.length === 0) return '当前没有待办。'
  const now = new Date()
  const lines = cs.map(c => {
    let tag = ''
    if (c.due) {
      const days = Math.ceil((new Date(c.due).getTime() - now.getTime()) / 86400000)
      tag = days <= 0 ? ' (今天!)' : days === 1 ? ' (明天)' : ` (${days}天后)`
    } else if (c.type === 'recurring') {
      tag = ' (每天)'
    }
    return `- ${c.content}${tag}`
  })
  return '待办:\n' + lines.join('\n')
}

// /盯盘 watchdog 状态(今日已告警)+ alerts.log 最近 10 条
function watchdogText(deps: CommandDeps): string {
  const lines: string[] = []
  const stPath = join(deps.dataDir, 'memory', 'watchdog-state.json')
  if (existsSync(stPath)) {
    try {
      const st = JSON.parse(readFileSync(stPath, 'utf-8')) as { date: string; fired: string[] }
      lines.push(`今日(${st.date})已告警 ${st.fired.length} 次:${st.fired.length ? st.fired.join(', ') : '无'}`)
    } catch { /* 坏了跳 */ }
  } else {
    lines.push('watchdog 还没跑过(可能未启用 / 非交易时段)')
  }
  const alertPath = join(deps.dataDir, 'memory', 'alerts.log')
  if (existsSync(alertPath)) {
    const all = readFileSync(alertPath, 'utf-8').trim().split('\n').filter(Boolean)
    const recent = all.slice(-10)
    if (recent.length > 0) {
      lines.push('', '最近告警:')
      lines.push(...recent)
    }
  }
  return lines.length > 0 ? lines.join('\n') : 'watchdog 无告警记录'
}

// /持仓 列真实持仓(portfolio.json 的 active 项),带止损止盈 + 浮亏提醒
function portfolioText(deps: CommandDeps): string {
  const positions = activePositions(deps.dataDir)
  if (positions.length === 0) return '当前没有记录真实持仓。\n(告诉我"买了 X N股 成本Y 止损Z",我记下来)'
  const lines = positions.map(p => {
    const sl = p.stop_loss != null ? ` 止损${p.stop_loss}` : ' 未设止损'
    const tp = p.take_profit != null ? ` 止盈${p.take_profit}` : ''
    return `- [${p.id}] ${p.code} ${p.name} ${p.qty}股@${p.cost}${sl}${tp}`
  })
  return '真实持仓:\n' + lines.join('\n')
}

// /tasks 列活跃 task(open/in_progress/in_review),区别于 /todo 的扁平承诺
function tasksText(deps: CommandDeps): string {
  const tasks = loadTasks(deps.dataDir).tasks.filter(t => t.status !== 'done' && t.status !== 'blocked')
  if (tasks.length === 0) return '现在没有在跟进的任务'
  const lines = tasks.map(t => {
    const next = t.next_step ? ` → ${t.next_step}` : ''
    return `- [${t.status}] ${t.title}${next} (${t.id})`
  })
  return '正在跟进的任务:\n' + lines.join('\n')
}

function memoryText(deps: CommandDeps, query: string): string {
  if (!query) return '请提供关键词，例如 /memory 深圳'
  const lines: string[] = []
  const rows = deps.store.searchHybrid(query, 6)
  for (const r of rows) {
    const t = relativeTime(new Date(r.timestamp), new Date())
    const who = r.role === 'user' ? '用户' : 'Shion'
    lines.push(`[${t}] ${who}: ${r.content.slice(0, 50)}`)
  }
  // 摘要也搜(episodes 之外的召回盲区)
  for (const s of deps.store.searchDailySummaries(query, 2)) {
    lines.push(`[${s.date} 摘要] ${s.summary.slice(0, 60)}`)
  }
  // 注:ima 知识库检索是异步的,/memory 这个同步命令不查它;Shion 走 memory_search 工具(含 ima)
  if (lines.length === 0) return `没找到关于"${query}"的记忆`
  return `关于"${query}":\n` + lines.join('\n')
}

function loadMood(dataDir: string): MoodState | null {
  const path = join(dataDir, 'memory', 'mood.json')
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf-8')) as MoodState } catch { return null }
}

function activeCommitments(dataDir: string): Commitment[] {
  const path = join(dataDir, 'memory', 'commitments.json')
  if (!existsSync(path)) return []
  try {
    const all = JSON.parse(readFileSync(path, 'utf-8')) as Commitment[]
    return all.filter(c => c.status === 'active')
  } catch { return [] }
}

function activePositions(dataDir: string): Position[] {
  const path = join(dataDir, 'memory', 'portfolio.json')
  if (!existsSync(path)) return []
  try {
    const all = JSON.parse(readFileSync(path, 'utf-8')) as Position[]
    return all.filter(p => p.status === 'active')
  } catch { return [] }
}

function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}秒`
  if (seconds < 3600) return `${Math.round(seconds / 60)}分钟`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}小时`
  return `${Math.round(seconds / 86400)}天`
}
