import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { MoodState } from '../../core/types.js'
import { getSysInfo, formatSysInfo } from '../../core/sysinfo.js'

export class TemporalLayer {
  private dataDir: string
  private lastSysCheck = 0
  private sysCache = ''

  constructor(dataDir: string) {
    this.dataDir = dataDir
  }

  assemble(lastUserContact?: Date, lastWake?: { time: Date; activity: string }): string {
    const now = new Date()
    const lines: string[] = []

    lines.push(`现在: ${formatDateTime(now)}`)
    lines.push('')

    if (lastUserContact) {
      lines.push(`距上次和哥哥说话: ${relativeTime(lastUserContact, now)}`)
    }

    if (lastWake) {
      lines.push(`距上次自己醒来: ${relativeTime(lastWake.time, now)} (${lastWake.activity})`)
    }

    const mood = this.loadMood()
    if (mood) {
      const moodSince = new Date(mood.since)
      lines.push(`心情: ${mood.current} (${relativeTime(moodSince, now)},${mood.reason})`)
    }

    const commitments = this.loadUpcomingCommitments()
    if (commitments.length > 0) {
      lines.push('')
      lines.push('待办提醒:')
      for (const c of commitments) {
        lines.push(`  - ${c}`)
      }
    }

    lines.push('')
    lines.push(`系统状态: ${this.sysStatus()}`)

    return lines.join('\n')
  }

  // 系统状态 30 秒缓存,别每次推理都去 statfs/nvidia-smi
  private sysStatus(): string {
    const now = Date.now()
    if (now - this.lastSysCheck > 30000 || !this.sysCache) {
      try {
        this.sysCache = formatSysInfo(getSysInfo())
      } catch {
        this.sysCache = '(读取失败)'
      }
      this.lastSysCheck = now
    }
    return this.sysCache
  }

  private loadMood(): MoodState | null {
    const path = join(this.dataDir, 'memory', 'mood.json')
    if (!existsSync(path)) return null
    try {
      return JSON.parse(readFileSync(path, 'utf-8'))
    } catch {
      return null
    }
  }

  private loadUpcomingCommitments(): string[] {
    const path = join(this.dataDir, 'memory', 'commitments.json')
    if (!existsSync(path)) return []
    try {
      const commitments = JSON.parse(readFileSync(path, 'utf-8')) as Array<{
        content: string; status: string; due?: string; type: string
      }>
      const now = new Date()
      const tomorrow = new Date(now)
      tomorrow.setDate(tomorrow.getDate() + 1)
      tomorrow.setHours(23, 59, 59)

      return commitments
        .filter(c => c.status === 'active')
        .filter(c => {
          if (c.type === 'recurring') return true
          if (!c.due) return true
          return new Date(c.due) <= tomorrow
        })
        .map(c => {
          if (c.due) {
            const due = new Date(c.due)
            const diffDays = Math.ceil((due.getTime() - now.getTime()) / 86400000)
            if (diffDays <= 0) return `${c.content} (今天!)`
            if (diffDays === 1) return `${c.content} (明天)`
            return `${c.content} (${diffDays}天后)`
          }
          return c.content
        })
        .slice(0, 5)
    } catch {
      return []
    }
  }
}

function formatDateTime(d: Date): string {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hour = d.getHours()
  const minute = String(d.getMinutes()).padStart(2, '0')
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  const weekday = weekdays[d.getDay()]!
  const period = getPeriod(hour)

  return `${year}-${month}-${day} ${String(hour).padStart(2, '0')}:${minute} ${weekday} ${period}`
}

function getPeriod(hour: number): string {
  if (hour < 5) return '凌晨'
  if (hour < 8) return '清晨'
  if (hour < 11) return '上午'
  if (hour < 13) return '中午'
  if (hour < 17) return '下午'
  if (hour < 19) return '傍晚'
  if (hour < 23) return '晚上'
  return '深夜'
}

export function relativeTime(past: Date, now: Date): string {
  const diffMs = now.getTime() - past.getTime()
  if (diffMs < 0) return '刚刚'

  const seconds = Math.floor(diffMs / 1000)
  if (seconds < 60) return '刚刚'

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}分钟前`

  const hours = Math.floor(minutes / 60)
  const remainMinutes = minutes % 60
  if (hours < 24) {
    if (remainMinutes > 0) return `${hours}小时${remainMinutes}分钟前`
    return `${hours}小时前`
  }

  const days = Math.floor(hours / 24)
  if (days === 1) return '昨天'
  if (days < 7) return `${days}天前`
  if (days < 30) return `${Math.floor(days / 7)}周前`
  return `${Math.floor(days / 30)}个月前`
}
