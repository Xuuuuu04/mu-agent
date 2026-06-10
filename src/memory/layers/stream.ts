import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { StreamEntry } from '../../core/types.js'

// 意识流窗口随活跃度同步放宽:06-10 哥哥把唤醒密度拉满(min 120s/max 3600s),
// 她一天可能醒 30-50 次,48 条保住至少一整天的思绪连续性(自主活动的"接着做"靠这个)
const MAX_ENTRIES = 48
const ACTIVITY_WINDOW = 10

export class StreamLayer {
  private filePath: string

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'memory', 'stream.md')
  }

  assemble(): string {
    const entries = this.loadEntries()
    if (entries.length === 0) return '(还没有意识流记录)'

    const lines: string[] = []

    for (const entry of entries) {
      const time = new Date(entry.timestamp)
      const hh = String(time.getHours()).padStart(2, '0')
      const mm = String(time.getMinutes()).padStart(2, '0')
      lines.push(`[${hh}:${mm}] ${entry.content}`)
    }

    const distribution = this.activityDistribution(entries)
    if (distribution.length > 0) {
      lines.push('')
      lines.push(`最近活动分布: ${distribution.join(' ')}`)
    }

    return lines.join('\n')
  }

  append(content: string, activityType?: string): void {
    const entries = this.loadEntries()

    entries.push({
      timestamp: new Date().toISOString(),
      content: content.trim(),
      activity_type: activityType,
    })

    while (entries.length > MAX_ENTRIES) {
      entries.shift()
    }

    this.saveEntries(entries)
  }

  private loadEntries(): StreamEntry[] {
    if (!existsSync(this.filePath)) return []
    try {
      const raw = readFileSync(this.filePath, 'utf-8')
      return JSON.parse(raw) as StreamEntry[]
    } catch {
      return this.parseLegacyFormat()
    }
  }

  private parseLegacyFormat(): StreamEntry[] {
    if (!existsSync(this.filePath)) return []
    const raw = readFileSync(this.filePath, 'utf-8')
    const entries: StreamEntry[] = []
    const lines = raw.split('\n')
    let current: string[] = []
    let currentTime = ''

    for (const line of lines) {
      const match = line.match(/^\[(\d{2}:\d{2})\]\s*(.*)/)
      if (match) {
        if (current.length > 0 && currentTime) {
          entries.push({ timestamp: currentTime, content: current.join('\n') })
        }
        currentTime = new Date().toISOString()
        current = [match[2]!]
      } else if (line.trim() && !line.startsWith('最近活动')) {
        current.push(line.trim())
      }
    }

    if (current.length > 0 && currentTime) {
      entries.push({ timestamp: currentTime, content: current.join('\n') })
    }

    return entries
  }

  private saveEntries(entries: StreamEntry[]): void {
    const dir = dirname(this.filePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(this.filePath, JSON.stringify(entries, null, 2), 'utf-8')
  }

  private activityDistribution(entries: StreamEntry[]): string[] {
    const recent = entries.slice(-ACTIVITY_WINDOW)
    const counts = new Map<string, number>()

    for (const e of recent) {
      const type = e.activity_type || 'other'
      counts.set(type, (counts.get(type) || 0) + 1)
    }

    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => `${type}(${count})`)
  }
}
