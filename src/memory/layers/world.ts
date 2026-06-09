import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

interface Note {
  name: string
  content: string
  terms: Set<string>
}

// L6 世界知识。data/knowledge/*.md,是 agent 浏览学习时自己写的笔记。
// 按话题关键词重合度匹配,把最相关的 1-2 篇摘要注入。L5 是"怎么做",L6 是"知道什么"。
export class WorldLayer {
  private knowledgeDir: string
  private cache: Note[] | null = null
  private cacheTime = 0

  constructor(dataDir: string) {
    this.knowledgeDir = join(dataDir, 'knowledge')
  }

  assemble(currentInput?: string): string {
    if (!currentInput) return ''
    const notes = this.loadNotes()
    if (notes.length === 0) return ''

    const queryTerms = this.tokenize(currentInput)
    if (queryTerms.size === 0) return ''

    const scored = notes
      .map(n => ({ note: n, score: this.overlap(queryTerms, n.terms) }))
      .filter(s => s.score >= 2)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)

    if (scored.length === 0) return ''

    const parts: string[] = ['--- 你的相关笔记 ---']
    for (const s of scored) {
      parts.push(`【${s.note.name}】`)
      parts.push(s.note.content.slice(0, 400).trim())
    }
    return parts.join('\n')
  }

  private loadNotes(): Note[] {
    if (this.cache && Date.now() - this.cacheTime < 30000) return this.cache
    if (!existsSync(this.knowledgeDir)) { this.cache = []; return [] }

    const notes: Note[] = []
    for (const file of readdirSync(this.knowledgeDir)) {
      if (!file.endsWith('.md')) continue
      try {
        const content = readFileSync(join(this.knowledgeDir, file), 'utf-8')
        notes.push({
          name: file.replace(/\.md$/, ''),
          content,
          terms: this.tokenize(content),
        })
      } catch { /* skip */ }
    }

    this.cache = notes
    this.cacheTime = Date.now()
    return notes
  }

  private tokenize(text: string): Set<string> {
    const words = text
      .replace(/[^一-龥a-zA-Z0-9]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 2)
    return new Set(words)
  }

  private overlap(a: Set<string>, b: Set<string>): number {
    let count = 0
    for (const t of a) if (b.has(t)) count++
    return count
  }

  list(): string[] {
    return this.loadNotes().map(n => n.name)
  }

  invalidate(): void {
    this.cache = null
  }
}
