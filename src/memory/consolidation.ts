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

    // 把已有记忆给模型对照,否则同一事实每次整合都重新提取一遍
    // (清理前 user-facts 里"6/2 答辩"重复了 9 次,就是没对照的结果)。
    // 对照必须给全文:之前 slice(-3000) 只盖到尾部,88 行中文已超 3000 字符,
    // 窗口外的旧事实照样重复提取(去重等于半失效)
    const factsPath = join(this.dataDir, 'memory', 'user-facts.md')
    const existingFacts = existsSync(factsPath)
      ? readFileSync(factsPath, 'utf-8')
      : '(还没有任何记忆)'

    try {
      const response = await this.router.chat({
        system: CONSOLIDATION_PROMPT,
        messages: [{
          role: 'user',
          content: `[已有记忆]\n${existingFacts}\n\n[最近的对话记录]\n${conversationText}\n\n请按格式提取——只要已有记忆里没有的新信息:`,
        }],
        max_tokens: 2000,
        // 提取是格式化任务,不值得 GLM 的 30-120s 推理;且 2000 max_tokens 会被 reasoning 吃光
        thinking: 'disabled',
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

  // session autocompact:把会话头部的多轮对话压成"前情提要",供 agent-loop 原位替换。
  // 与 summarizeSession 不同——这个结果留在活跃会话里继续参与对话,要保住可续聊的细节
  async compactHistory(history: ChatMessage[]): Promise<string | null> {
    const text = history
      .map(m => {
        const role = m.role === 'user' ? '哥哥' : '沐'
        if (typeof m.content === 'string') return `${role}: ${m.content}`
        const parts = m.content.map(b => {
          if (b.type === 'text') return b.text ?? ''
          if (b.type === 'tool_use') return `[用了工具 ${b.name}]`
          return ''
        }).filter(Boolean).join(' ')
        return parts ? `${role}: ${parts}` : ''
      })
      .filter(Boolean)
      .join('\n')

    if (text.length < 50) return null

    try {
      const response = await this.router.chat({
        system: '把这段对话压成简短的"前情提要"。保留:聊了什么关键的事、做过的决定、还没做完的事、当时的情绪氛围。用沐的第一人称视角,称对方"哥哥",口语化,300字以内,只输出提要本身。',
        messages: [{ role: 'user', content: text.slice(0, 8000) }],
        max_tokens: 800,
        // 800 tokens 的预算禁不起 reasoning 吃,吃光=压缩失败=只剩硬裁剪兜底
        thinking: 'disabled',
      })
      const summary = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim()
      return summary || null
    } catch (err) {
      console.error(`[consolidation] 会话压缩失败: ${(err as Error).message}`)
      return null
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
        // 200 tokens 给推理模型必被 reasoning 吃光(归档摘要从来没成功过的根因)
        max_tokens: 200,
        thinking: 'disabled',
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
        const fact = trimmed.slice(2).trim()
        // "无/没有新事实"这种解释性输出不是事实,别存(曾出现"[consolidation] 无(用户仅回复了…)")
        if (fact && !/^无([(（]|$)|^没有/.test(fact)) facts.push(fact)
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

const CONSOLIDATION_PROMPT = `你是沐的记忆整合助手,帮她从对话记录里提取值得长期记住的新信息。

输出格式:

[事实]
- 哥哥提到的新事实(日期、计划、偏好、健康等)
- 只提取值得长期记忆的信息,跳过闲聊

[摘要]
一两句话概括这段对话的主要内容

[情绪]
这段对话中哥哥的情绪变化轨迹

硬规则:
- 会给你"已有记忆"做对照:已经记过的事实绝对不要再输出,换个说法也不行。宁可事实段留空
- 称呼他"哥哥",不要叫"用户"。口吻是沐自己在记事,口语化,别用书面腔
- 只提取哥哥明确说过的事实,不要推测,不要把沐自己说的话当成事实
- 瞬时状态不要存:GPU温度、磁盘空间、当天天气这种过几天就没意义的,跳过
- 日期一律用绝对日期(几月几号),绝不用"明天/后天/昨天/下周"这种相对词(过几天再读就错位了)
- 新事实和旧记忆矛盾时(比如计划变了),写成"(更新:原来X,现在Y)"
- 没有新事实就把事实段留空,不要写"无"或解释为什么没有
- 不用 markdown 加粗/列表符号以外的格式`
