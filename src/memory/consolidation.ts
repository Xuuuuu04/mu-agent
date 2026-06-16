import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryStore } from './store.js'
import type { ModelRouter } from '../providers/router.js'
import type { ChatMessage } from '../core/types.js'
import { absolutizeTime } from './absolutize.js'
import { EmbeddingService } from './embedding.js'

export class MemoryConsolidation {
  private store: MemoryStore
  private router: ModelRouter
  private dataDir: string
  private embedding: EmbeddingService | null
  private lastConsolidation: Date | null = null

  constructor(store: MemoryStore, router: ModelRouter, dataDir: string, embedding?: EmbeddingService | null) {
    this.store = store
    this.router = router
    this.dataDir = dataDir
    this.embedding = embedding ?? null
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

      const parsed = parseConsolidationResult(text)

      if (parsed.facts.length > 0) {
        await this.appendFacts(parsed.facts)
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

  private async appendFacts(facts: string[]): Promise<void> {
    const path = join(this.dataDir, 'memory', 'user-facts.md')
    const existing = existsSync(path) ? readFileSync(path, 'utf-8') : ''
    const absolutized = facts.map(f => absolutizeTime(f))
    // 两级去重:确定性子串匹配(零成本) → 语义 cosine(一次 batch HTTP)
    let fresh = dedupeFacts(absolutized, existing)
    if (fresh.length > 0 && this.embedding?.available) {
      const existingLines = existing.split('\n').map(l => l.trim()).filter(l => l.length > 4)
      fresh = await semanticDedupeFacts(fresh, existingLines, this.embedding)
    }
    if (fresh.length === 0) return
    const date = new Date().toISOString().slice(0, 10)
    const newEntries = fresh.map(f => `[${date}] [consolidation] ${f}`).join('\n')
    writeFileSync(path, existing + '\n' + newEntries + '\n', 'utf-8')
  }
}

// 语义去重:确定性子串匹配之后的第二道关。用 embedding cosine 捕捉措辞不同但语义重复的事实。
// 阈值 0.85:宁可漏删(保留疑似重复)也不误删(丢真新信息)。embedding 挂了全部放行(降级)
const SEMANTIC_DEDUP_THRESHOLD = 0.85

export async function semanticDedupeFacts(
  newFacts: string[],
  existingLines: string[],
  embedding: EmbeddingService,
  threshold = SEMANTIC_DEDUP_THRESHOLD,
): Promise<string[]> {
  if (newFacts.length === 0 || existingLines.length === 0) return newFacts

  // 去掉 [日期] [tag] 前缀,只嵌入语义内容
  const stripPrefix = (s: string) => s.replace(/^\[[^\]]*\]\s*(\[[^\]]*\]\s*)?/, '').trim()
  const existingContents = existingLines.map(stripPrefix).filter(l => l.length > 4)
  if (existingContents.length === 0) return newFacts

  const allTexts = [...existingContents, ...newFacts]
  const vecs = await embedding.embedBatch(allTexts)

  // batch 全挂 → 降级,全部放行
  if (vecs.every(v => v === null)) return newFacts

  const existingVecs = vecs.slice(0, existingContents.length)
  const newVecs = vecs.slice(existingContents.length)

  const result: string[] = []
  for (let i = 0; i < newFacts.length; i++) {
    const nv = newVecs[i]
    if (!nv) { result.push(newFacts[i]!); continue }

    let maxSim = 0
    for (let j = 0; j < existingContents.length; j++) {
      const ev = existingVecs[j]
      if (!ev) continue
      const sim = EmbeddingService.cosine(nv, ev)
      if (sim > maxSim) maxSim = sim
    }

    if (maxSim < threshold) {
      result.push(newFacts[i]!)
    } else {
      console.log(`[consolidation] 语义去重: "${newFacts[i]!.slice(0, 30)}" ≈ 已有 (sim=${maxSim.toFixed(3)})`)
    }
  }
  return result
}

// 确定性去重兜底:LLM 被注入已有事实做对照,但仍会重复提取(措辞略变就认不出,
// 清理前"6/2 答辩"重复过 9 次)。写库前再过一道——归一化后已被某条现有事实
// 完整包含的新事实跳过。保守:只跳完全冗余,不丢更新/超集(新事实更长则保留)。
export function dedupeFacts(newFacts: string[], existingText: string): string[] {
  const norm = (s: string) => s
    .replace(/^\[[^\]]*\]\s*\[[^\]]*\]\s*/g, '')          // 去 [日期] [tag] 前缀
    .replace(/[\s，。、,.\-—:：;；!！?？"'""'']/g, '')
    .toLowerCase()
  const existing = existingText.split('\n').map(norm).filter(l => l.length > 4)
  const seen = new Set(existing)
  const out: string[] = []
  for (const f of newFacts) {
    const nf = norm(f)
    if (nf.length <= 4) { out.push(f); continue }           // 太短不敢判,照常存
    if (seen.has(nf)) continue                               // 完全相同
    if (existing.some(e => e.includes(nf))) continue         // 已被某条现有事实完整包含
    out.push(f)
    seen.add(nf)
  }
  return out
}

// 解析 consolidation LLM 的输出:分 [事实]/[摘要]/[情绪] 段。纯函数,可单测。
// "无/没有新事实"这种解释性输出不当事实存(曾污染 user-facts)。
export function parseConsolidationResult(text: string): {
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
