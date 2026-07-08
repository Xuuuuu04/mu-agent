import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Commitment, Position } from '../../core/types.js'

export class RelationsLayer {
  private dataDir: string

  constructor(dataDir: string) {
    this.dataDir = dataDir
  }

  assemble(): string {
    const parts: string[] = []

    const facts = this.loadFacts()
    if (facts) {
      parts.push('--- 关于用户(你记住的事实) ---')
      parts.push(facts)
    }

    const commitments = this.loadActiveCommitments()
    if (commitments.length > 0) {
      parts.push('')
      parts.push('--- 你答应过的事 ---')
      for (const c of commitments) {
        const due = c.due ? ` (${this.formatDue(c.due)})` : ''
        const schedule = c.schedule ? ` [${c.schedule}]` : ''
        const lastDone = c.last_done ? ` 上次: ${this.formatRelative(c.last_done)}` : ''
        parts.push(`- [${c.id}] ${c.content}${due}${schedule}${lastDone}`)
      }
    }

    const positions = this.loadActivePositions()
    if (positions.length > 0) {
      parts.push('')
      parts.push('--- 当前持仓(真实账户,非模拟盘) ---')
      for (const p of positions) {
        const sl = p.stop_loss != null ? ` 止损${p.stop_loss}` : ''
        const tp = p.take_profit != null ? ` 止盈${p.take_profit}` : ''
        const note = p.note ? ` // ${p.note}` : ''
        parts.push(`- [${p.id}] ${p.code} ${p.name} ${p.qty}股@${p.cost}${sl}${tp}${note}`)
      }
      parts.push('(watchdog 盘中会按止损/止盈监控这些票;改仓位用 portfolio_* 工具)')
    }

    if (parts.length === 0) {
      return '(还没有记住关于用户的事实)'
    }

    return parts.join('\n')
  }

  private loadFacts(): string | null {
    const path = join(this.dataDir, 'memory', 'user-facts.md')
    if (!existsSync(path)) return null
    const content = readFileSync(path, 'utf-8').trim()
    if (!content) return null

    if (content.length > 3000) {
      return content.slice(0, 3000) + '\n...(更多事实省略)'
    }
    return content
  }

  private loadActiveCommitments(): Commitment[] {
    const path = join(this.dataDir, 'memory', 'commitments.json')
    if (!existsSync(path)) return []
    try {
      const all = JSON.parse(readFileSync(path, 'utf-8')) as Commitment[]
      return all.filter(c => c.status === 'active')
    } catch {
      return []
    }
  }

  private loadActivePositions(): Position[] {
    const path = join(this.dataDir, 'memory', 'portfolio.json')
    if (!existsSync(path)) return []
    try {
      const all = JSON.parse(readFileSync(path, 'utf-8')) as Position[]
      return all.filter(p => p.status === 'active')
    } catch {
      return []
    }
  }

  private formatDue(due: string): string {
    const d = new Date(due)
    const now = new Date()
    const diffMs = d.getTime() - now.getTime()
    const diffDays = Math.ceil(diffMs / 86400_000)

    if (diffDays < 0) return `已过期${Math.abs(diffDays)}天!`
    if (diffDays === 0) return '今天!'
    if (diffDays === 1) return '明天'
    if (diffDays <= 7) return `${diffDays}天后`
    return due
  }

  private formatRelative(isoStr: string): string {
    const then = new Date(isoStr)
    const now = new Date()
    const diffMs = now.getTime() - then.getTime()
    const hours = Math.floor(diffMs / 3600_000)
    if (hours < 1) return '刚刚'
    if (hours < 24) return `${hours}小时前`
    const days = Math.floor(hours / 24)
    if (days === 1) return '昨天'
    return `${days}天前`
  }
}
