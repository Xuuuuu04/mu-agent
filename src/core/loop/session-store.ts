// 会话状态机:拥有 sessionHistory / sessionId / lastActivity,负责裁剪、轮转、
// autocompact(带代次校验)、落盘/恢复。从 agent-loop 抽出来,单一职责、可独立单测。
// 这些都是 06-09 死亡螺旋事故换来的不变量,改这里先跑 session-store.test.ts。
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import type { ChatMessage } from '../types.js'
import { trimHistory, isSafeStart } from '../history.js'
import { sanitizeMessages } from '../../providers/sanitize-messages.js'

// autocompact 只需要 consolidation 的 compactHistory,不耦合整个 MemoryConsolidation
export interface CompactConsolidation {
  compactHistory: (head: ChatMessage[]) => Promise<string | null>
}

function newSessionId(): string {
  return `s_${Date.now().toString(36)}`
}

export class SessionStore {
  private history: ChatMessage[] = []
  private _sessionId: string
  private _lastActivity = Date.now()
  private compacting = false
  private readonly file: string

  constructor(sessionFile: string) {
    this.file = sessionFile
    this._sessionId = newSessionId()
  }

  get sessionId(): string { return this._sessionId }
  get lastActivity(): number { return this._lastActivity }
  get length(): number { return this.history.length }

  push(msg: ChatMessage): void { this.history.push(msg) }

  // 裁剪到安全切点(切点必须落纯文本 user,防孤儿 tool_result)并返回副本
  buildMessages(max = 40): ChatMessage[] {
    this.history = trimHistory(this.history, max)
    return [...this.history]
  }

  // lastActivity 只该在 cycle 成功后被调用——失败的 cycle 不算活动,
  // 否则坏历史导致的反复失败会一直刷新计时,session 永不轮转,坏历史永生(06-09 事故)
  markActivity(): void { this._lastActivity = Date.now() }

  // 距上次活动超时则归档当前会话(清空开新),归档动作(生成摘要)交回调
  maybeRotate(timeoutMs: number, onArchive: (oldSessionId: string, history: ChatMessage[]) => void): void {
    if (this.history.length === 0) return
    if (Date.now() - this._lastActivity < timeoutMs) return
    const oldId = this._sessionId
    const hist = this.history
    this.history = []
    this._sessionId = newSessionId()
    this.removeFile()
    onArchive(oldId, hist)
  }

  // session autocompact:历史超过 30 条就把头部压成一条"前情提要",原位替换。
  // 跑在 postProcess(异步)里,期间下一个 cycle 可能已开动,所以替换前做代次校验(宁可不压,不能错接)。
  async maybeCompact(consolidation: CompactConsolidation | null): Promise<void> {
    if (this.compacting || !consolidation) return
    if (this.history.length <= 30) return
    this.compacting = true
    try {
      const sid = this._sessionId
      // 头部至少 16 条,延伸到安全切点,保证替换后剩余历史以纯文本 user 开头
      let headEnd = 16
      while (headEnd < this.history.length - 8 && !isSafeStart(this.history[headEnd]!)) {
        headEnd++
      }
      if (headEnd >= this.history.length - 4) return
      const head = this.history.slice(0, headEnd)

      const summary = await consolidation.compactHistory(head)
      if (!summary) return

      // 代次校验:压缩期间 session 被轮转/清空/裁剪过就放弃
      if (this._sessionId !== sid) return
      if (this.history.length < headEnd || this.history[0] !== head[0]) return

      this.history.splice(0, headEnd, {
        role: 'user',
        content: `[前情提要,你们之前聊的浓缩] ${summary}`,
      })
      console.log(`[agent-loop] 会话压缩: ${headEnd} 条 → 1 条前情提要`)
      this.persist()
    } finally {
      this.compacting = false
    }
  }

  // 会话落盘:重启(部署/崩溃)不再丢短期对话记忆。autocompact 把规模压在 ~40 条内,写整个文件没负担
  persist(): void {
    try {
      writeFileSync(this.file, JSON.stringify({
        sessionId: this._sessionId,
        lastActivity: this._lastActivity,
        history: this.history,
      }))
    } catch { /* 落盘失败不影响对话 */ }
  }

  // 启动时恢复落盘会话(第一个 cycle 之前)。恢复要过两道闸:
  // sanitize 防孤儿工具块、trimHistory 保证切点。
  restore(): void {
    if (!existsSync(this.file)) return
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf-8')) as {
        sessionId?: string; lastActivity?: number; history?: ChatMessage[]
      }
      if (!Array.isArray(saved.history) || saved.history.length === 0) return
      const { messages, dropped } = sanitizeMessages(saved.history)
      if (dropped.length > 0) console.warn(`[agent-loop] 恢复会话时剔除非法块: ${dropped.join('; ')}`)
      this.history = trimHistory(messages, 40)
      if (typeof saved.sessionId === 'string' && saved.sessionId) this._sessionId = saved.sessionId
      if (typeof saved.lastActivity === 'number') this._lastActivity = saved.lastActivity
      console.log(`[agent-loop] 恢复落盘会话: ${this.history.length} 条 (${this._sessionId})`)
      // 清理了脏数据就立即写回,不然每次重启都重复告警(孤儿幽灵)
      if (dropped.length > 0) this.persist()
    } catch { /* 文件坏了当全新会话 */ }
  }

  clear(): void {
    this.history = []
    this._sessionId = newSessionId()
    this.removeFile()
  }

  private removeFile(): void {
    try { unlinkSync(this.file) } catch { /* 不存在就算了 */ }
  }
}
