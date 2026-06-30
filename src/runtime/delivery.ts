// 主动消息投递:发 QQ bridge + outbox 兜底重投 + sendRouter 路由。
// 用结构化接口注入依赖,便于单测(mock fetch / outbox)。
import type { OutgoingMessage } from '../core/types.js'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// 投递只需要 outbox 的存取,不依赖整个 WebhookGateway
export interface OutboxSink {
  pushOutbox(text: string): void
  takeOutbox(): Array<{ id: number; text: string; ts: number }>
}

export interface Delivery {
  postToQQ: (text: string, imagePath?: string) => Promise<void>
  deliverToUser: (text: string, imagePath?: string) => Promise<void>
  drainOutbox: () => Promise<void>
}

// fetch 默认用全局 fetch,测试可注入
export function createDelivery(
  qqSendUrl: string,
  outbox: OutboxSink,
  fetchImpl: typeof fetch = fetch,
): Delivery {
  // 只负责把一条消息 POST 到 QQ bridge,失败抛错(不兜底),供 deliverToUser/drainOutbox 复用
  const postToQQ = async (text: string, imagePath?: string): Promise<void> => {
    const r = await fetchImpl(qqSendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(imagePath ? { text, image: imagePath } : { text }),
      signal: AbortSignal.timeout(30000),
    })
    const d = await r.json().catch(() => ({})) as { ok?: boolean; error?: string }
    if (!r.ok || !d.ok) throw new Error(d.error ?? `HTTP ${r.status}`)
  }

  // QQ 恢复后把积压的 outbox 逐条补发;某条再失败就塞回并停手(QQ 还没好)
  const drainOutbox = async (): Promise<void> => {
    for (const item of outbox.takeOutbox()) {
      try {
        await postToQQ(item.text)
        console.log(`  [outbox] 补发成功: ${item.text.slice(0, 30)}`)
      } catch {
        outbox.pushOutbox(item.text)
        break
      }
    }
  }

  const deliverToUser = async (text: string, imagePath?: string): Promise<void> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await postToQQ(text, imagePath)
        console.log(`  [deliver] 主动消息已发 QQ${imagePath ? '(带图)' : ''}`)
        await drainOutbox()   // 这次通了,顺手把之前积压的也补发掉
        return
      } catch (e) {
        if (attempt < 2) { await sleep(500 * 2 ** attempt); continue }
        // outbox 只兜文本;图片发不出去让她下次再试(文件还在她手里)
        outbox.pushOutbox(imagePath ? `${text}\n(本想带一张图: ${imagePath},没发出去)` : text)
        console.error(`[deliver] QQ 主动发送失败 3 次,转 outbox: ${(e as Error).message}`)
      }
    }
  }

  return { postToQQ, deliverToUser, drainOutbox }
}

export interface SendRouterDeps {
  cli: { send: (msg: OutgoingMessage) => Promise<void> }
  recordSent: () => void          // proactive.recordSent
  pushOutbox: (text: string) => void
  deliverToUser: (text: string, imagePath?: string) => Promise<void>
}

// message_send / 主动消息的发送路由(按 source 分四路)
export function createSendRouter(deps: SendRouterDeps) {
  return async (source: string, text: string, imagePath?: string): Promise<void> => {
    if (source === 'cli') {
      await deps.cli.send({ target: { source: 'cli', chat_id: 'local' }, content: [{ type: 'text', text }] })
      return
    }
    if (source === 'autonomous') {
      deps.recordSent()
      console.log(`\nShion(主动): ${text}${imagePath ? ` [图:${imagePath}]` : ''}\n`)
      await deps.deliverToUser(text, imagePath)
    } else if (source === 'webhook') {
      // QQ 对话中途沐又多说的一条:必须走 QQ 主动推,否则塞进 web-only outbox 用户根本看不到
      console.log(`\nShion(追发): ${text}${imagePath ? ` [图:${imagePath}]` : ''}\n`)
      await deps.deliverToUser(text, imagePath)
    } else {
      // 其他来源(微信 iLink 主动推有 stale-token 硬限制)只能进 outbox 兜底
      deps.pushOutbox(text)
    }
  }
}
