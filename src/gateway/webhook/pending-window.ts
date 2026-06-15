// 同步回复窗口:被动消息进来时挂一个 pending,等 cycle 跑完 resolve。
// 超 110s(GLM 慢推理 + 多轮工具)还没 resolve 就超时返回空——这时回复改走主动推送,
// 否则就地蒸发(用户视角=已读不回)。msgId 带自增后缀防同毫秒并发碰撞。
//
// 注意:register() 只负责挂 pending 并返回 promise;handler 的调用时序由 gateway 控制
//(必须在拿到 promise 之后、await 之前调,否则同步 resolve 会丢)。

export class PendingWindow {
  private pending = new Map<string, (text: string) => void>()
  private seq = 0
  private readonly timeoutMs: number

  constructor(timeoutMs = 110000) {
    this.timeoutMs = timeoutMs
  }

  register(): { id: string; promise: Promise<string> } {
    const id = `wh_${Date.now().toString(36)}_${(this.seq++).toString(36)}`
    const promise = new Promise<string>((resolve) => {
      this.pending.set(id, resolve)
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          // 超时返回空(不发"(超时)"穿帮占位符);cycle 跑完会通过主动通道补发真实回复
          resolve('')
        }
      }, this.timeoutMs)
    })
    return { id, promise }
  }

  resolve(id: string, text: string): boolean {
    const resolver = this.pending.get(id)
    if (!resolver) return false
    resolver(text)
    this.pending.delete(id)
    return true
  }

  has(id: string): boolean {
    return this.pending.has(id)
  }
}
