import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryStore } from '../memory/store.js'
import type { Scheduler } from './scheduler.js'
import type { Commitment, MoodState } from './types.js'
import { relativeTime } from '../memory/layers/temporal.js'

export interface CommandDeps {
  dataDir: string
  store: MemoryStore
  scheduler: Scheduler
  clearSession: () => void
  uptimeSeconds: () => number
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
      return '好啦 这轮聊天清空 重新开始～\n(放心 你的事我都还记着呢 清掉的只是这次对话 不是记忆)'
    case 'status': case 's':
      return statusText(deps)
    case 'mood':
      return moodText(deps)
    case 'todo': case 'commitments':
      return todoText(deps)
    case 'memory': case 'mem':
      return memoryText(deps, parts.slice(1).join(' '))
    default:
      return `没这个命令诶～ 发 /help 看看有啥能用的`
  }
}

function helpText(): string {
  return [
    '能用的命令:',
    '/new 或 /clear — 清空这轮对话(长期记忆保留)',
    '/status — 看我的状态(心情/记忆/下次醒)',
    '/mood — 我现在什么心情',
    '/todo — 答应你的事都在这',
    '/memory 关键词 — 翻翻我记得的事',
    '/help — 就是这个',
  ].join('\n')
}

function statusText(deps: CommandDeps): string {
  const mood = loadMood(deps.dataDir)
  const lines: string[] = []
  lines.push(`心情: ${mood?.current ?? 'calm'}${mood?.reason ? ` — ${mood.reason}` : ''}`)
  lines.push(`记忆: ${deps.store.getEpisodeCount()} 条`)
  lines.push(`已经醒着: ${fmtDuration(deps.uptimeSeconds())}`)
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
  if (cs.length === 0) return '没有待办～ 你答应的事我都看着呢,有新的随时记'
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
  return '答应你的事:\n' + lines.join('\n')
}

function memoryText(deps: CommandDeps, query: string): string {
  if (!query) return '想翻什么? 比如 /memory 深圳'
  const rows = deps.store.searchHybrid(query, 6)
  if (rows.length === 0) return `没找到关于"${query}"的记忆`
  const lines = rows.map(r => {
    const t = relativeTime(new Date(r.timestamp), new Date())
    const who = r.role === 'user' ? '你' : '我'
    return `[${t}] ${who}: ${r.content.slice(0, 50)}`
  })
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

function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}秒`
  if (seconds < 3600) return `${Math.round(seconds / 60)}分钟`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}小时`
  return `${Math.round(seconds / 86400)}天`
}
