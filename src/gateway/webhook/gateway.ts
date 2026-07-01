// WebhookGateway:HTTP 网关(:3210,只绑回环)。瘦壳——同步窗口交 PendingWindow、
// 待发件交 Outbox、面板 API 交 AdminApi;自己只管生命周期、路由分发、消息/事件入站。
import { createServer, type IncomingMessage as HttpReq, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { IncomingMessage, GatewayAdapter, OutgoingMessage } from '../../core/types.js'
import type { MemoryStore } from '../../memory/store.js'
import type { WebhookOpts } from './opts.js'
import { Outbox, type OutboxItem } from './outbox.js'
import { PendingWindow } from './pending-window.js'
import { AdminApi } from './admin-api.js'
import { serveStatic } from './static-server.js'
import { isOriginAllowed, readBody, sendJson } from './http-utils.js'

export type { WebhookOpts } from './opts.js'

export class WebhookGateway implements GatewayAdapter {
  name = 'webhook'
  private port: number
  private server: ReturnType<typeof createServer> | null = null
  private handler: ((msg: IncomingMessage) => void) | null = null
  private eventHandler: ((event: string, payload: unknown) => void) | null = null
  private store: MemoryStore | null
  private opts: WebhookOpts
  private outbox: Outbox
  private pending: PendingWindow
  private admin: AdminApi

  constructor(opts: WebhookOpts = {}) {
    this.opts = opts
    this.port = opts.port ?? 3210
    this.store = opts.store ?? null
    this.outbox = new Outbox(opts.dataDir ? join(opts.dataDir, 'memory', 'outbox.json') : null)
    this.pending = new PendingWindow()
    this.admin = new AdminApi({
      store: this.store,
      opts: this.opts,
      outbox: this.outbox,
      getEventHandler: () => this.eventHandler,
    })
  }

  pushOutbox(text: string): void { this.outbox.push(text) }
  takeOutbox(): OutboxItem[] { return this.outbox.take() }

  async connect(): Promise<void> {
    this.server = createServer((req, res) => this.handleRequest(req, res))
    return new Promise((resolve) => {
      // 绑回环:webhook 和 Web 控制台只听本机。两个 Python bridge 都是本机 POST,不受影响;
      // 远程访问 Web 控制台走 SSH 隧道。避免把"冒充哥哥跑 LLM / 读写 config·soul"的接口暴露到网络。
      this.server!.listen(this.port, '127.0.0.1', () => {
        console.log(`[webhook] HTTP 服务: http://127.0.0.1:${this.port}`)
        resolve()
      })
    })
  }

  async disconnect(): Promise<void> {
    return new Promise((resolve) => {
      this.server?.close(() => resolve())
    })
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.handler = handler
  }

  onEvent(handler: (event: string, payload: unknown) => void): void {
    this.eventHandler = handler
  }

  async send(msg: OutgoingMessage): Promise<void> {
    const text = msg.content.map(c => c.type === 'text' ? c.text : `[${c.type}]`).join('\n')
    this.pending.resolve(msg.reply_to ?? '', text)
  }

  // 同步等待还在不在:cycle 跑超 110s 后 resolver 已超时移除,
  // 这时回复必须改走主动推送,否则就地蒸发(用户视角=已读不回)
  hasPending(id: string): boolean {
    return this.pending.has(id)
  }

  private async handleRequest(req: HttpReq, res: ServerResponse): Promise<void> {
    const origin = req.headers.origin
    if (!isOriginAllowed(origin, req.headers.host)) {
      sendJson(res, { error: 'cross-origin request denied' }, 403)
      return
    }
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    const url = new URL(req.url ?? '/', `http://localhost:${this.port}`)
    const p = url.pathname
    const m = req.method

    try {
      if (await this.admin.tryHandle(p, m, req, res, url.searchParams)) return
      if (p === '/webhook/message' && m === 'POST') await this.handleMessage(req, res)
      else if (p === '/webhook/event' && m === 'POST') await this.handleEvent(req, res)
      else if (this.opts.webDir) serveStatic(this.opts.webDir, p, res)
      else { res.writeHead(404); res.end(JSON.stringify({ error: 'not found' })) }
    } catch (err) {
      // 可能 serveStatic 已 writeHead，二次 writeHead 会抛 ERR_HTTP_HEADERS_SENT 未捕获崩进程
      if (!res.headersSent) {
        res.writeHead(500)
        res.end(JSON.stringify({ error: (err as Error).message }))
      } else {
        res.end()
      }
    }
  }

  private async handleMessage(req: HttpReq, res: ServerResponse): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readBody(req))
    } catch {
      sendJson(res, { error: 'invalid json' }, 400)
      return
    }
    // 空文本直接拒收:否则会打断她的闹钟+空跑一整个 LLM cycle
    // (06-10 一条 schema 错误的测试 POST 就这样吵醒过她)。
    // 先确认 parsed 是对象:body 是 null/数组/裸数字时 parsed.text 会抛 TypeError 被外层 catch 成 500。
    const obj = (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      ? parsed as Record<string, unknown>
      : null
    if (!obj || !obj.text || !String(obj.text).trim()) {
      sendJson(res, { error: 'text is required' }, 400)
      return
    }
    const { id: msgId, promise } = this.pending.register()
    const msg: IncomingMessage = {
      id: msgId,
      source: 'webhook',
      chat_type: obj.chat_type === 'group' ? 'group' : 'private',
      sender: { id: (obj.sender_id as string) || 'webhook', name: (obj.sender_name as string) || '未知' },
      content: { type: 'text', text: String(obj.text) },
      timestamp: Date.now(),
    }

    // handler 必须在拿到 promise 之后、await 之前调(handler 可能同步 resolve)
    this.handler?.(msg)
    sendJson(res, { response: await promise })
  }

  private async handleEvent(req: HttpReq, res: ServerResponse): Promise<void> {
    const parsed = JSON.parse(await readBody(req)) as { event?: string; payload?: unknown }
    const event = parsed.event ?? 'unknown'
    this.eventHandler?.(event, parsed.payload)
    sendJson(res, { ok: true, event })
  }
}
