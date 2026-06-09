import type { MemoryStore, EpisodeRow } from '../store.js'
import { relativeTime } from './temporal.js'
import { EmbeddingService } from '../embedding.js'
import { extractEntities } from '../entities.js'

// L4 情景记忆。四路检索:近期窗口 + 语义(embedding) + 关键词(FTS) + 时间/实体。
export class EpisodicLayer {
  private store: MemoryStore
  private embedding: EmbeddingService | null

  constructor(store: MemoryStore, embedding?: EmbeddingService | null) {
    this.store = store
    this.embedding = embedding ?? null
  }

  async assemble(currentInput?: string): Promise<string> {
    const parts: string[] = []

    const recentSummary = this.getRecentSummary()
    if (recentSummary) {
      parts.push('--- 最近24小时的对话摘要 ---')
      parts.push(recentSummary)
    }

    if (currentInput) {
      const relevant = await this.searchRelevant(currentInput)
      if (relevant.length > 0) {
        parts.push('')
        parts.push('--- 你记得的相关经历 ---')
        for (const r of relevant) {
          parts.push(this.formatEpisode(r.ep, r.why))
        }
      }
    }

    return parts.join('\n')
  }

  saveEpisode(data: {
    source: string
    role: string
    content: string
    sessionId?: string
    entities?: string[]
  }): void {
    const id = `ep_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
    this.store.insertEpisode({
      id,
      timestamp: new Date().toISOString(),
      source: data.source,
      role: data.role,
      content: data.content,
      summary: null,
      embedding: null,
      session_id: data.sessionId ?? null,
      topic_tags: null,
      entities: data.entities ? JSON.stringify(data.entities) : null,
    })
  }

  private getRecentSummary(): string | null {
    const today = new Date().toISOString().slice(0, 10)
    const todaySummary = this.store.getDailySummary(today)
    if (todaySummary) return todaySummary.summary

    const recent = this.store.getRecentEpisodes(24, 20)
    if (recent.length === 0) return null

    const lines: string[] = []
    for (const ep of recent.reverse().slice(0, 10)) {
      const role = ep.role === 'user' ? '哥哥' : '我'
      const preview = ep.content.slice(0, 80).replace(/\n/g, ' ')
      const time = relativeTime(new Date(ep.timestamp), new Date())
      lines.push(`[${time}] ${role}: ${preview}`)
    }
    return lines.join('\n')
  }

  // 四路检索合并,去重(排除最近24h已在摘要里出现的)
  private async searchRelevant(query: string): Promise<Array<{ ep: EpisodeRow; why: string }>> {
    const recentIds = new Set(this.store.getRecentEpisodes(24, 50).map(e => e.id))
    const seen = new Set<string>()
    const out: Array<{ ep: EpisodeRow; why: string }> = []

    const add = (ep: EpisodeRow, why: string): void => {
      if (recentIds.has(ep.id) || seen.has(ep.id)) return
      seen.add(ep.id)
      out.push({ ep, why })
    }

    // 路径1: 语义检索(有 embedding 才走)
    if (this.embedding?.available) {
      try {
        const qv = await this.embedding.embed(query)
        if (qv) {
          const candidates = this.store.getEpisodesWithEmbedding(2000)
          const scored = candidates
            .filter(ep => ep.embedding)
            .map(ep => ({ ep, score: EmbeddingService.cosine(qv, EmbeddingService.fromBuffer(ep.embedding!)) }))
            .filter(s => s.score > 0.45)
            .sort((a, b) => b.score - a.score)
            .slice(0, 5)
          for (const s of scored) add(s.ep, `相关 ${s.score.toFixed(2)}`)
        }
      } catch { /* 语义挂了不影响其它路径 */ }
    }

    // 路径2: 关键词检索。FTS(OR) + 每个词的 LIKE 子串(补中文分词缺陷)
    const keywords = this.extractKeywords(query)
    if (keywords.length > 0) {
      const ftsQuery = keywords.map(k => `"${k}"`).join(' OR ')
      try {
        for (const ep of this.store.searchFTS(ftsQuery, 5)) add(ep, '关键词')
      } catch { /* FTS 语法错就跳过 */ }
      for (const k of keywords) {
        for (const ep of this.store.searchLike(k, 2)) add(ep, '关键词')
      }
    }

    // 路径3: 时间检索(输入含时间词)
    const range = this.parseTimeRange(query)
    if (range) {
      for (const ep of this.store.getEpisodesByTimeRange(range.from, range.to, 5)) {
        add(ep, range.label)
      }
    }

    // 路径4: 实体检索(输入含已知实体)
    const dict = new Set(this.store.getKnownEntities(200))
    for (const entity of extractEntities(query, dict)) {
      for (const ep of this.store.getEpisodesByEntity(entity, 3)) add(ep, `提到${entity}`)
    }

    return out.slice(0, 8)
  }

  // 把中文相对时间词解析成 ISO 时间范围
  private parseTimeRange(text: string): { from: string; to: string; label: string } | null {
    const now = new Date()
    const startOfDay = (d: Date): Date => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }
    const dayOffset = (n: number): { from: Date; to: Date } => {
      const from = startOfDay(new Date(now.getTime() + n * 86400000))
      const to = new Date(from.getTime() + 86400000)
      return { from, to }
    }

    let range: { from: Date; to: Date } | null = null
    let label = '时间匹配'

    if (text.includes('前天')) { range = dayOffset(-2); label = '前天' }
    else if (text.includes('昨天') || text.includes('昨晚')) { range = dayOffset(-1); label = '昨天' }
    else if (text.includes('今天') || text.includes('今早') || text.includes('今晚')) { range = dayOffset(0); label = '今天' }
    else if (text.includes('上周') || text.includes('上星期') || text.includes('上礼拜')) {
      range = { from: new Date(now.getTime() - 14 * 86400000), to: new Date(now.getTime() - 7 * 86400000) }
      label = '上周'
    } else if (text.includes('这周') || text.includes('本周') || text.includes('这星期')) {
      range = { from: new Date(now.getTime() - 7 * 86400000), to: now }
      label = '这周'
    } else if (text.includes('上个月') || text.includes('上月')) {
      range = { from: new Date(now.getTime() - 60 * 86400000), to: new Date(now.getTime() - 30 * 86400000) }
      label = '上个月'
    }

    if (!range) return null
    return { from: range.from.toISOString(), to: range.to.toISOString(), label }
  }

  private extractKeywords(text: string): string[] {
    const stopWords = new Set([
      '的', '了', '在', '是', '我', '你', '他', '她', '它', '们',
      '这', '那', '有', '和', '就', '也', '都', '不', '吗', '呢',
      '吧', '啊', '呀', '嘛', '哦', '哈', '嗯', '诶', '啦',
      '什么', '怎么', '为什么', '怎样', '哪', '几', '多', '一个',
      '一下', '可以', '能', '会', '要', '想', '说', '做', '去',
    ])

    const words = text
      .replace(/[^一-龥a-zA-Z0-9]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 2 && !stopWords.has(w))

    return [...new Set(words)].slice(0, 5)
  }

  private formatEpisode(ep: EpisodeRow, why?: string): string {
    const time = relativeTime(new Date(ep.timestamp), new Date())
    const date = new Date(ep.timestamp)
    const dateStr = `${date.getMonth() + 1}月${date.getDate()}日`
    const role = ep.role === 'user' ? '哥哥' : '我'
    const content = ep.content.length > 150
      ? ep.content.slice(0, 150) + '...'
      : ep.content
    const tag = why ? ` (${why})` : ''
    return `[${dateStr} ${time}]${tag} ${role}: ${content}`
  }

  get episodeCount(): number {
    return this.store.getEpisodeCount()
  }
}
