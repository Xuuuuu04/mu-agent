import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryStore } from './store.js'
import type { ModelRouter } from '../providers/router.js'
import type { ChatMessage } from '../core/types.js'
import { absolutizeTime } from './absolutize.js'

export class MemoryConsolidation {
  private store: MemoryStore
  private router: ModelRouter
  private dataDir: string
  private lastConsolidation: Date | null = null

  constructor(store: MemoryStore, router: ModelRouter, dataDir: string) {
    this.store = store
    this.router = router
    this.dataDir = dataDir
  }

  shouldConsolidate(): boolean {
    const unconsolidated = this.store.getUnconsolidated(1)
    const count = this.store.getUnconsolidated(100).length

    if (count >= 50) return true

    if (this.lastConsolidation) {
      const hoursSince = (Date.now() - this.lastConsolidation.getTime()) / 3600_000
      if (hoursSince >= 6 && count > 0) return true
    } else if (count > 10) {
      return true
    }

    return false
  }

  async consolidate(): Promise<{ factsExtracted: number; summariesCreated: number }> {
    const episodes = this.store.getUnconsolidated(100)
    if (episodes.length === 0) return { factsExtracted: 0, summariesCreated: 0 }

    console.log(`[consolidation] 整合 ${episodes.length} 条未处理记忆...`)

    const conversationText = episodes.map(ep => {
      const time = new Date(ep.timestamp).toLocaleString('zh-CN')
      const role = ep.role === 'user' ? '哥哥' : '沐'
      return `[${time}] ${role}: ${ep.content}`
    }).join('\n')

    try {
      const response = await this.router.chat({
        system: CONSOLIDATION_PROMPT,
        messages: [{
          role: 'user',
          content: `以下是最近的对话记录,请提取重要信息:\n\n${conversationText}`,
        }],
        max_tokens: 2000,
      })

      const text = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('')

      const parsed = this.parseConsolidationResult(text)

      if (parsed.facts.length > 0) {
        this.appendFacts(parsed.facts)
      }

      const today = new Date().toISOString().slice(0, 10)
      if (parsed.summary) {
        this.store.upsertDailySummary({
          date: today,
          summary: parsed.summary,
          key_facts: parsed.facts.join('\n') || null,
          mood_trajectory: parsed.mood || null,
        })
      }

      this.store.markConsolidated(episodes.map(e => e.id))
      this.lastConsolidation = new Date()

      console.log(`[consolidation] 提取了 ${parsed.facts.length} 条事实, 生成了日摘要`)

      return {
        factsExtracted: parsed.facts.length,
        summariesCreated: parsed.summary ? 1 : 0,
      }
    } catch (err) {
      console.error(`[consolidation] 整合失败: ${(err as Error).message}`)
      return { factsExtracted: 0, summariesCreated: 0 }
    }
  }

  // 会话超时归档时调用:把这段会话压成一两句摘要,存成一条可检索的记忆
  async summarizeSession(sessionId: string, history: ChatMessage[]): Promise<void> {
    const text = history
      .map(m => {
        const role = m.role === 'user' ? '哥哥' : '沐'
        const content = typeof m.content === 'string'
          ? m.content
          : m.content.map(b => b.type === 'text' ? (b.text ?? '') : '').join('')
        return content ? `${role}: ${content}` : ''
      })
      .filter(Boolean)
      .join('\n')

    if (text.length < 30) return

    try {
      const response = await this.router.chat({
        system: '用一两句话概括这段对话聊了什么,口语化,不超过50字。只输出摘要本身。',
        messages: [{ role: 'user', content: text.slice(0, 4000) }],
        max_tokens: 200,
      })
      const summary = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim()
      if (!summary) return

      this.store.insertEpisode({
        id: `ep_${Date.now().toString(36)}_sess`,
        timestamp: new Date().toISOString(),
        source: 'session',
        role: null,
        content: summary,
        summary,
        embedding: null,
        session_id: sessionId,
        topic_tags: null,
        entities: null,
      })
      console.log(`[consolidation] 会话 ${sessionId} 摘要: ${summary.slice(0, 40)}`)
    } catch (err) {
      console.error(`[consolidation] 会话摘要失败: ${(err as Error).message}`)
      // 摘要 LLM 挂了也别让这段会话彻底消失：存一条原文截断的 fallback，至少保证可检索
      this.store.insertEpisode({
        id: `ep_${Date.now().toString(36)}_sess`,
        timestamp: new Date().toISOString(),
        source: 'session',
        role: null,
        content: text.slice(0, 200),
        summary: null,
        embedding: null,
        session_id: sessionId,
        topic_tags: null,
        entities: null,
      })
    }
  }

  private parseConsolidationResult(text: string): {
    facts: string[]
    summary: string | null
    mood: string | null
  } {
    const facts: string[] = []
    let summary: string | null = null
    let mood: string | null = null
    let currentSection = ''

    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('[事实]') || trimmed.startsWith('事实:')) {
        currentSection = 'facts'
      } else if (trimmed.startsWith('[摘要]') || trimmed.startsWith('摘要:')) {
        currentSection = 'summary'
        summary = trimmed.replace(/^\[摘要\]\s*|^摘要:\s*/, '')
      } else if (trimmed.startsWith('[情绪]') || trimmed.startsWith('情绪:')) {
        currentSection = 'mood'
        mood = trimmed.replace(/^\[情绪\]\s*|^情绪:\s*/, '')
      } else if (trimmed.startsWith('- ') && currentSection === 'facts') {
        facts.push(trimmed.slice(2))
      } else if (currentSection === 'summary' && trimmed && !summary) {
        summary = trimmed
      } else if (currentSection === 'mood' && trimmed && !mood) {
        mood = trimmed
      }
    }

    if (!summary && text.length > 20) {
      summary = text.slice(0, 200)
    }

    return { facts, summary, mood }
  }

  private appendFacts(facts: string[]): void {
    const path = join(this.dataDir, 'memory', 'user-facts.md')
    const existing = existsSync(path) ? readFileSync(path, 'utf-8') : ''
    const date = new Date().toISOString().slice(0, 10)
    // 固化相对时间,长期事实里不留"明天/昨天"
    const newEntries = facts.map(f => `[${date}] [consolidation] ${absolutizeTime(f)}`).join('\n')
    writeFileSync(path, existing + '\n' + newEntries + '\n', 'utf-8')
  }
}

const CONSOLIDATION_PROMPT = `你是一个记忆整合助手。你的任务是从对话记录中提取重要信息。

输出格式:

[事实]
- 用户提到的新事实(日期、计划、偏好、健康等)
- 只提取值得长期记忆的信息,跳过闲聊

[摘要]
一两句话概括这段对话的主要内容

[情绪]
这段对话中用户的情绪变化轨迹

注意:
- 只提取用户明确说过的事实,不要推测
- 如果没有值得记忆的事实,事实部分留空
- 摘要要简洁,不要重复原文
- **日期一律用绝对日期(几月几号),绝不用"明天/后天/昨天/下周"这种相对词**(过几天再读就错位了)
- 如果新事实和旧记忆矛盾(比如计划变了),在事实里注明"(更新:原来X,现在Y)"`
