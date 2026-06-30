// 待发件箱:主动消息发 QQ 失败时落这里,QQ 恢复后由 mu.ts 重投。
// 自包含状态机(内存 deque 上限 50 + JSON 落盘),便于单测。
import { readFileSync, existsSync } from 'node:fs'
import { atomicWriteJsonSync } from '../../core/atomic-file.js'

export interface OutboxItem { id: number; text: string; ts: number }

export class Outbox {
  private items: OutboxItem[] = []
  private seq = 0
  private file: string | null

  constructor(file: string | null) {
    this.file = file
    this.load()
  }

  push(text: string): void {
    this.items.push({ id: ++this.seq, text, ts: Date.now() })
    if (this.items.length > 50) {
      const dropped = this.items.shift()
      console.warn(`[outbox] 队列满 50,丢弃最旧一条: ${dropped?.text.slice(0, 40)}`)
    }
    this.save()
  }

  // 取出全部待发并清空(QQ 恢复后重投);重投失败的由调用方再 push 塞回
  take(): OutboxItem[] {
    const items = this.items
    this.items = []
    this.save()
    return items
  }

  // 面板查询用:只读地取 id 大于 since 的待发件
  peek(since: number): OutboxItem[] {
    return this.items.filter(m => m.id > since)
  }

  private load(): void {
    if (!this.file || !existsSync(this.file)) return
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf-8')) as { seq?: number; messages?: OutboxItem[] }
      if (Array.isArray(data.messages)) {
        this.items = data.messages
        this.seq = data.seq ?? this.items.reduce((mx, x) => Math.max(mx, x.id), 0)
      }
    } catch { /* 坏了就当空队列 */ }
  }

  private save(): void {
    if (!this.file) return
    try {
      atomicWriteJsonSync(this.file, { seq: this.seq, messages: this.items })
    } catch { /* 落盘失败不影响主流程 */ }
  }
}
