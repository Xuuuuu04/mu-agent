import { createServer, type IncomingMessage as HttpReq, type ServerResponse } from 'node:http'
import { readFileSync, existsSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname, basename, sep } from 'node:path'
import YAML from 'yaml'
import type { IncomingMessage, GatewayAdapter, OutgoingMessage } from '../core/types.js'
import type { MemoryStore } from '../memory/store.js'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

export interface WebhookOpts {
  port?: number
  store?: MemoryStore
  webDir?: string
  soulDir?: string
  dataDir?: string
  configPath?: string
  logDir?: string
  getTools?: () => string[]
  // agent 心跳信息(最后成功 cycle/连续失败数/下次唤醒),没有它 pm2 online ≠ 沐活着
  getAgentHealth?: () => Record<string, unknown>
}

export class WebhookGateway implements GatewayAdapter {
  name = 'webhook'
  private port: number
  private server: ReturnType<typeof createServer> | null = null
  private handler: ((msg: IncomingMessage) => void) | null = null
  private eventHandler: ((event: string, payload: unknown) => void) | null = null
  private store: MemoryStore | null
  private pendingResponses = new Map<string, (text: string) => void>()
  private opts: WebhookOpts
  private outbox: Array<{ id: number; text: string; ts: number }> = []
  private outboxSeq = 0
  private outboxFile: string | null
  private msgSeq = 0

  constructor(opts: WebhookOpts = {}) {
    this.opts = opts
    this.port = opts.port ?? 3210
    this.store = opts.store ?? null
    this.outboxFile = opts.dataDir ? join(opts.dataDir, 'memory', 'outbox.json') : null
    this.loadOutbox()
  }

  pushOutbox(text: string): void {
    this.outbox.push({ id: ++this.outboxSeq, text, ts: Date.now() })
    if (this.outbox.length > 50) {
      const dropped = this.outbox.shift()
      console.warn(`[outbox] 队列满 50，丢弃最旧一条: ${dropped?.text.slice(0, 40)}`)
    }
    this.saveOutbox()
  }

  // 取出全部待发并清空(给 mu.ts 在 QQ 恢复后重投)；重投失败的由调用方再 pushOutbox 塞回
  takeOutbox(): Array<{ id: number; text: string; ts: number }> {
    const items = this.outbox
    this.outbox = []
    this.saveOutbox()
    return items
  }

  private loadOutbox(): void {
    if (!this.outboxFile || !existsSync(this.outboxFile)) return
    try {
      const data = JSON.parse(readFileSync(this.outboxFile, 'utf-8')) as { seq?: number; messages?: Array<{ id: number; text: string; ts: number }> }
      if (Array.isArray(data.messages)) {
        this.outbox = data.messages
        this.outboxSeq = data.seq ?? this.outbox.reduce((mx, x) => Math.max(mx, x.id), 0)
      }
    } catch { /* 坏了就当空队列 */ }
  }

  private saveOutbox(): void {
    if (!this.outboxFile) return
    try {
      writeFileSync(this.outboxFile, JSON.stringify({ seq: this.outboxSeq, messages: this.outbox }))
    } catch { /* 落盘失败不影响主流程 */ }
  }

  async connect(): Promise<void> {
    this.server = createServer((req, res) => this.handleRequest(req, res))
    return new Promise((resolve) => {
      // 绑回环：webhook 和 Web 控制台只听本机。两个 Python bridge 都是本机 POST，不受影响；
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
    const resolver = this.pendingResponses.get(msg.reply_to ?? '')
    if (resolver) {
      const text = msg.content.map(c => c.type === 'text' ? c.text : `[${c.type}]`).join('\n')
      resolver(text)
      this.pendingResponses.delete(msg.reply_to ?? '')
    }
  }

  // 同步等待还在不在:cycle 跑超 110s 后 resolver 已超时移除,
  // 这时回复必须改走主动推送,否则就地蒸发(用户视角=已读不回)
  hasPending(id: string): boolean {
    return this.pendingResponses.has(id)
  }

  private async handleRequest(req: HttpReq, res: ServerResponse): Promise<void> {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    const url = new URL(req.url ?? '/', `http://localhost:${this.port}`)
    const p = url.pathname
    const m = req.method

    try {
      if (p === '/api/status' && m === 'GET') this.handleStatus(res)
      else if (p === '/api/stream' && m === 'GET') this.handleStream(res)
      else if (p === '/api/recent-notes' && m === 'GET') this.handleRecentNotes(res)
      else if (p === '/api/diary-latest' && m === 'GET') this.handleDiaryLatest(res)
      else if (p === '/api/guestbook' && m === 'GET') this.handleGuestbookGet(res)
      else if (p === '/api/guestbook' && m === 'POST') await this.handleGuestbookPost(req, res)
      else if (p === '/api/memory' && m === 'GET') this.handleMemoryQuery(res, url.searchParams)
      else if (p === '/api/episodes' && m === 'GET') this.handleEpisodes(res, url.searchParams)
      else if (p === '/api/outbox' && m === 'GET') this.handleOutbox(res, url.searchParams)
      else if (p === '/api/commitments' && m === 'GET') this.handleCommitments(res)
      else if (p === '/api/mood' && m === 'GET') this.handleMood(res)
      else if (p === '/api/tools' && m === 'GET') this.handleTools(res)
      else if (p === '/api/logs' && m === 'GET') this.handleLogs(res, url.searchParams)
      else if (p === '/api/config' && m === 'GET') this.handleConfigGet(res)
      else if (p === '/api/config' && m === 'POST') await this.handleConfigPost(req, res)
      else if (p === '/api/soul' && m === 'GET') this.handleSoulGet(res, url.searchParams)
      else if (p === '/api/soul' && m === 'POST') await this.handleSoulPost(req, res)
      else if (p === '/webhook/message' && m === 'POST') await this.handleMessage(req, res)
      else if (p === '/webhook/event' && m === 'POST') await this.handleEvent(req, res)
      else if (this.opts.webDir) this.serveStatic(p, res)
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

  private json(res: ServerResponse, data: unknown, code = 200): void {
    res.writeHead(code, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  private handleStatus(res: ServerResponse): void {
    this.json(res, {
      version: '0.2.0',
      uptime: process.uptime(),
      episodes: this.store?.getEpisodeCount() ?? 0,
      memory_rss: Math.round(process.memoryUsage.rss() / 1024 / 1024),
      mood: this.readMood(),
      ...(this.opts.getAgentHealth?.() ?? {}),
    })
  }

  private handleMemoryQuery(res: ServerResponse, params: URLSearchParams): void {
    const query = params.get('q')
    if (!query || !this.store) { this.json(res, { error: 'missing q parameter' }, 400); return }
    this.json(res, { results: this.store.searchHybrid(query, 10) })
  }

  private handleEpisodes(res: ServerResponse, params: URLSearchParams): void {
    const hours = clampInt(params.get('hours'), 24, 1, 720)
    const limit = clampInt(params.get('limit'), 50, 1, 500)
    this.json(res, { episodes: this.store?.getRecentEpisodes(hours, limit) ?? [] })
  }

  private handleOutbox(res: ServerResponse, params: URLSearchParams): void {
    const since = clampInt(params.get('since'), 0, 0, Number.MAX_SAFE_INTEGER)
    this.json(res, { messages: this.outbox.filter(msg => msg.id > since) })
  }

  private handleCommitments(res: ServerResponse): void {
    this.json(res, { commitments: this.readJsonFile('memory/commitments.json') ?? [] })
  }

  private handleMood(res: ServerResponse): void {
    this.json(res, this.readMood() ?? { current: 'calm', reason: '' })
  }

  private handleTools(res: ServerResponse): void {
    this.json(res, { tools: this.opts.getTools?.() ?? [] })
  }

  private handleLogs(res: ServerResponse, params: URLSearchParams): void {
    const lines = clampInt(params.get('lines'), 100, 1, 1000)
    if (!this.opts.logDir) { this.json(res, { logs: [] }); return }
    const today = new Date().toISOString().slice(0, 10)
    const file = join(this.opts.logDir, `mu-${today}.log`)
    if (!existsSync(file)) { this.json(res, { logs: [] }); return }
    const all = readFileSync(file, 'utf-8').trim().split('\n')
    this.json(res, { logs: all.slice(-lines) })
  }

  private handleConfigGet(res: ServerResponse): void {
    if (!this.opts.configPath || !existsSync(this.opts.configPath)) { this.json(res, { error: 'no config' }, 404); return }
    const parsed = YAML.parse(readFileSync(this.opts.configPath, 'utf-8')) as Record<string, unknown>
    // 不把密钥送出去
    const safe = {
      scheduler: parsed.scheduler,
      agent: parsed.agent,
      proactive: parsed.proactive,
      model_primary: (parsed.model as { primary?: { name?: string; model?: string } })?.primary?.name,
    }
    this.json(res, safe)
  }

  private async handleConfigPost(req: HttpReq, res: ServerResponse): Promise<void> {
    if (!this.opts.configPath || !existsSync(this.opts.configPath)) { this.json(res, { error: 'no config' }, 404); return }
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>
    const parsed = YAML.parse(readFileSync(this.opts.configPath, 'utf-8')) as Record<string, unknown>
    // 只允许改这几段,密钥/模型配置不动
    for (const key of ['scheduler', 'agent', 'proactive'] as const) {
      if (body[key]) parsed[key] = { ...(parsed[key] as object), ...(body[key] as object) }
    }
    writeFileSync(this.opts.configPath, YAML.stringify(parsed), 'utf-8')
    this.json(res, { ok: true, note: '已写入,重启生效' })
  }

  private handleSoulGet(res: ServerResponse, params: URLSearchParams): void {
    if (!this.opts.soulDir) { this.json(res, { files: [] }); return }
    const file = params.get('file')
    if (file) {
      const safe = basename(file)
      const path = join(this.opts.soulDir, safe)
      if (!existsSync(path)) { this.json(res, { error: 'not found' }, 404); return }
      this.json(res, { file: safe, content: readFileSync(path, 'utf-8') })
    } else {
      const files = existsSync(this.opts.soulDir)
        ? readdirSync(this.opts.soulDir).filter(f => f.endsWith('.md'))
        : []
      this.json(res, { files })
    }
  }

  private async handleSoulPost(req: HttpReq, res: ServerResponse): Promise<void> {
    if (!this.opts.soulDir) { this.json(res, { error: 'no soul dir' }, 404); return }
    const body = JSON.parse(await readBody(req)) as { file?: string; content?: string }
    if (!body.file || body.content === undefined) { this.json(res, { error: 'missing file/content' }, 400); return }
    const safe = basename(body.file)
    if (!safe.endsWith('.md')) { this.json(res, { error: 'only .md' }, 400); return }
    writeFileSync(join(this.opts.soulDir, safe), body.content, 'utf-8')
    this.json(res, { ok: true })
  }

  private async handleMessage(req: HttpReq, res: ServerResponse): Promise<void> {
    const parsed = JSON.parse(await readBody(req))
    // 空文本直接拒收:否则会打断她的闹钟+空跑一整个 LLM cycle
    // (06-10 一条 schema 错误的测试 POST 就这样吵醒过她)
    if (!parsed.text || !String(parsed.text).trim()) {
      this.json(res, { error: 'text is required' }, 400)
      return
    }
    // 加自增后缀，避免同毫秒并发请求 msgId 碰撞导致 pendingResponses 串号/覆盖
    const msgId = `wh_${Date.now().toString(36)}_${(this.msgSeq++).toString(36)}`
    const msg: IncomingMessage = {
      id: msgId,
      source: 'webhook',
      chat_type: parsed.chat_type || 'private',
      sender: { id: parsed.sender_id || 'webhook', name: parsed.sender_name || '未知' },
      content: { type: 'text', text: parsed.text || '' },
      timestamp: Date.now(),
    }

    const responsePromise = new Promise<string>((resolve) => {
      this.pendingResponses.set(msgId, resolve)
      // GLM-5.1 是推理模型,慢(reasoning 30-60s + 多轮工具),给足时间。
      // bridge 的 _ask_mu 是 120s 超时,这里留 10s margin。
      setTimeout(() => {
        if (this.pendingResponses.has(msgId)) {
          this.pendingResponses.delete(msgId)
          // 超时返回空(不发"(超时)"穿帮占位符);沐 cycle 跑完会通过主动通道补发真实回复
          resolve('')
        }
      }, 110000)
    })

    this.handler?.(msg)
    this.json(res, { response: await responsePromise })
  }

  private async handleEvent(req: HttpReq, res: ServerResponse): Promise<void> {
    const parsed = JSON.parse(await readBody(req)) as { event?: string; payload?: unknown }
    const event = parsed.event ?? 'unknown'
    this.eventHandler?.(event, parsed.payload)
    this.json(res, { ok: true, event })
  }

  private serveStatic(pathname: string, res: ServerResponse): void {
    const dir = this.opts.webDir!
    let filePath = pathname === '/' ? '/index.html' : pathname
    filePath = join(dir, filePath)
    // startsWith(dir) 缺分隔符边界，同前缀兄弟目录(web-evil)能绕过；要求严格落在 dir 下
    if (filePath !== dir && !filePath.startsWith(dir + sep)) { res.writeHead(403); res.end(); return }
    if (!existsSync(filePath)) { res.writeHead(404); res.end('Not Found'); return }
    const mime = MIME_TYPES[extname(filePath)] || 'application/octet-stream'
    // 先读再写头：readFileSync 抛错(文件刚被删/变目录)时还没 writeHead(200)，外层 catch 能干净处理
    const data = readFileSync(filePath)
    res.writeHead(200, { 'Content-Type': mime })
    res.end(data)
  }

  // 她的面板用:意识流(签名取最后一条非空内容)
  private handleStream(res: ServerResponse): void {
    const entries = this.readJsonFile('memory/stream.md')
    this.json(res, { entries: Array.isArray(entries) ? entries.slice(-8) : [] })
  }

  // 她的面板用:最近的知识笔记(标题 + 首段摘录)
  private handleRecentNotes(res: ServerResponse): void {
    if (!this.opts.dataDir) { this.json(res, { notes: [] }); return }
    const dir = join(this.opts.dataDir, 'knowledge')
    if (!existsSync(dir)) { this.json(res, { notes: [] }); return }
    const files = readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .map(f => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 5)
    const notes = files.map(({ f, mtime }) => {
      const raw = readFileSync(join(dir, f), 'utf-8')
      const body = raw.replace(/^#[^\n]*\n/, '').replace(/^>[^\n]*\n/gm, '').trim()
      const firstPara = body.split(/\n\s*\n/)[0]?.replace(/\n/g, ' ').trim() ?? ''
      return {
        title: f.replace(/\.md$/, '').replace(/^wander-/, '').replace(/-\d{4}-\d{2}-\d{2}$/, ''),
        excerpt: firstPara.slice(0, 120),
        date: new Date(mtime).toISOString().slice(0, 10),
      }
    })
    this.json(res, { notes })
  }

  // 她的面板用:日记最后一段(最近在写什么)
  private handleDiaryLatest(res: ServerResponse): void {
    if (!this.opts.dataDir) { this.json(res, { entry: null }); return }
    const path = join(this.opts.dataDir, 'memory', '日记.md')
    if (!existsSync(path)) { this.json(res, { entry: null }); return }
    const raw = readFileSync(path, 'utf-8')
    const sections = raw.split(/^## /m).filter(s => s.trim())
    const last = sections[sections.length - 1]
    if (!last) { this.json(res, { entry: null }); return }
    const [header, ...body] = last.split('\n')
    this.json(res, { entry: { date: header?.trim(), text: body.join('\n').trim().slice(0, 400) } })
  }

  private handleGuestbookGet(res: ServerResponse): void {
    const data = this.readJsonFile('memory/留言板.json')
    this.json(res, { messages: Array.isArray(data) ? data.slice(-20) : [] })
  }

  // 留言会写进她家的留言板,并立刻作为事件唤醒她——有人来看她了,她该知道
  private async handleGuestbookPost(req: HttpReq, res: ServerResponse): Promise<void> {
    if (!this.opts.dataDir) { this.json(res, { error: 'no data dir' }, 500); return }
    const body = JSON.parse(await readBody(req)) as { name?: string; text?: string }
    const text = (body.text ?? '').trim().slice(0, 500)
    if (!text) { this.json(res, { error: 'empty' }, 400); return }
    const name = (body.name ?? '访客').trim().slice(0, 20) || '访客'
    const path = join(this.opts.dataDir, 'memory', '留言板.json')
    const list = (() => {
      try { return JSON.parse(readFileSync(path, 'utf-8')) as unknown[] } catch { return [] }
    })()
    list.push({ name, text, time: new Date().toISOString() })
    writeFileSync(path, JSON.stringify(list.slice(-100), null, 2), 'utf-8')
    this.eventHandler?.(`留言板有新留言,${name}说: ${text}`, { name, text })
    this.json(res, { ok: true })
  }

  private readMood(): unknown {
    return this.readJsonFile('memory/mood.json')
  }

  private readJsonFile(rel: string): unknown {
    if (!this.opts.dataDir) return null
    const path = join(this.opts.dataDir, rel)
    if (!existsSync(path)) return null
    try { return JSON.parse(readFileSync(path, 'utf-8')) } catch { return null }
  }
}

function readBody(req: HttpReq): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

// URL 整数参数兜底：非法/NaN 回落默认值并 clamp 到 [min,max]，防 slice(-NaN) 返回整表或脏输入 500
function clampInt(raw: string | null, def: number, min: number, max: number): number {
  const n = parseInt(raw ?? '')
  if (!Number.isFinite(n)) return def
  return Math.max(min, Math.min(max, n))
}
