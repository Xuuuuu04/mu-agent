// 面板/管理 API:她的 Web 小房间和管理命令的只读查询 + 受限写入(config/soul/留言板)。
// 从主网关剥出来,让 WebhookGateway 回到"网关"本质。所有路由经 tryHandle 分发。
import { VERSION } from '../../version.js'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import YAML from 'yaml'
import type { IncomingMessage as HttpReq, ServerResponse } from 'node:http'
import type { MemoryStore } from '../../memory/store.js'
import type { WebhookOpts } from './opts.js'
import type { Outbox } from './outbox.js'
import { readBody, clampInt, sendJson } from './http-utils.js'
import { atomicWriteFileSync, atomicWriteJsonSync } from '../../core/atomic-file.js'

export interface AdminApiDeps {
  store: MemoryStore | null
  opts: WebhookOpts
  outbox: Outbox
  // eventHandler 在 connect 后才设,用 getter 而不是拷贝引用
  getEventHandler: () => ((event: string, payload: unknown) => void) | null
}

export class AdminApi {
  constructor(private deps: AdminApiDeps) {}

  private get store(): MemoryStore | null { return this.deps.store }
  private get opts(): WebhookOpts { return this.deps.opts }

  // 命中 admin 路由就处理并返回 true,否则 false(交给网关的其余路由)
  async tryHandle(p: string, m: string | undefined, req: HttpReq, res: ServerResponse, params: URLSearchParams): Promise<boolean> {
    if (m === 'GET') {
      switch (p) {
        case '/api/status': this.handleStatus(res); return true
        case '/api/stream': this.handleStream(res); return true
        case '/api/recent-notes': this.handleRecentNotes(res); return true
        case '/api/diary-latest': this.handleDiaryLatest(res); return true
        case '/api/guestbook': this.handleGuestbookGet(res); return true
        case '/api/memory': this.handleMemoryQuery(res, params); return true
        case '/api/episodes': this.handleEpisodes(res, params); return true
        case '/api/outbox': this.handleOutbox(res, params); return true
        case '/api/commitments': this.handleCommitments(res); return true
        case '/api/todos': this.handleTodos(res); return true
        case '/api/mood': this.handleMood(res); return true
        case '/api/tools': this.handleTools(res); return true
        case '/api/logs': this.handleLogs(res, params); return true
        case '/api/config': this.handleConfigGet(res); return true
        case '/api/soul': this.handleSoulGet(res, params); return true
      }
    } else if (m === 'POST') {
      switch (p) {
        case '/api/guestbook': await this.handleGuestbookPost(req, res); return true
        case '/api/config': await this.handleConfigPost(req, res); return true
        case '/api/soul': await this.handleSoulPost(req, res); return true
      }
    }
    return false
  }

  private handleStatus(res: ServerResponse): void {
    sendJson(res, {
      version: VERSION,
      uptime: process.uptime(),
      episodes: this.store?.getEpisodeCount() ?? 0,
      memory_rss: Math.round(process.memoryUsage.rss() / 1024 / 1024),
      mood: this.readMood(),
      ...(this.opts.getAgentHealth?.() ?? {}),
    })
  }

  private handleMemoryQuery(res: ServerResponse, params: URLSearchParams): void {
    const query = params.get('q')
    if (!query || !this.store) { sendJson(res, { error: 'missing q parameter' }, 400); return }
    sendJson(res, { results: this.store.searchHybrid(query, 10) })
  }

  private handleEpisodes(res: ServerResponse, params: URLSearchParams): void {
    const hours = clampInt(params.get('hours'), 24, 1, 720)
    const limit = clampInt(params.get('limit'), 50, 1, 500)
    sendJson(res, { episodes: this.store?.getRecentEpisodes(hours, limit) ?? [] })
  }

  private handleOutbox(res: ServerResponse, params: URLSearchParams): void {
    const since = clampInt(params.get('since'), 0, 0, Number.MAX_SAFE_INTEGER)
    sendJson(res, { messages: this.deps.outbox.peek(since) })
  }

  private handleCommitments(res: ServerResponse): void {
    sendJson(res, { commitments: this.readJsonFile('memory/commitments.json') ?? [] })
  }

  // 只读返回 active-tasks.json 的任务列表(Task 系统)
  private handleTodos(res: ServerResponse): void {
    const data = this.readJsonFile('memory/active-tasks.json') as { tasks?: unknown[] } | null
    sendJson(res, { tasks: Array.isArray(data?.tasks) ? data!.tasks : [] })
  }

  private handleMood(res: ServerResponse): void {
    sendJson(res, this.readMood() ?? { current: 'calm', reason: '' })
  }

  private handleTools(res: ServerResponse): void {
    sendJson(res, { tools: this.opts.getTools?.() ?? [] })
  }

  private handleLogs(res: ServerResponse, params: URLSearchParams): void {
    const lines = clampInt(params.get('lines'), 100, 1, 1000)
    if (!this.opts.logDir) { sendJson(res, { logs: [] }); return }
    const today = new Date().toISOString().slice(0, 10)
    const file = join(this.opts.logDir, `mu-${today}.log`)
    if (!existsSync(file)) { sendJson(res, { logs: [] }); return }
    const all = readFileSync(file, 'utf-8').trim().split('\n')
    sendJson(res, { logs: all.slice(-lines) })
  }

  private handleConfigGet(res: ServerResponse): void {
    if (!this.opts.configPath || !existsSync(this.opts.configPath)) { sendJson(res, { error: 'no config' }, 404); return }
    const parsed = YAML.parse(readFileSync(this.opts.configPath, 'utf-8')) as Record<string, unknown>
    // 不把密钥送出去
    const safe = {
      scheduler: parsed.scheduler,
      agent: parsed.agent,
      proactive: parsed.proactive,
      model_primary: (parsed.model as { primary?: { name?: string; model?: string } })?.primary?.name,
    }
    sendJson(res, safe)
  }

  private async handleConfigPost(req: HttpReq, res: ServerResponse): Promise<void> {
    if (!this.opts.configPath || !existsSync(this.opts.configPath)) { sendJson(res, { error: 'no config' }, 404); return }
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>
    const parsed = YAML.parse(readFileSync(this.opts.configPath, 'utf-8')) as Record<string, unknown>
    // 只允许改这几段,密钥/模型配置不动
    for (const key of ['scheduler', 'agent', 'proactive'] as const) {
      if (body[key]) parsed[key] = { ...(parsed[key] as object), ...(body[key] as object) }
    }
    atomicWriteFileSync(this.opts.configPath, YAML.stringify(parsed))
    sendJson(res, { ok: true, note: '已写入,重启生效' })
  }

  private handleSoulGet(res: ServerResponse, params: URLSearchParams): void {
    if (!this.opts.soulDir) { sendJson(res, { files: [] }); return }
    const file = params.get('file')
    if (file) {
      const safe = basename(file)
      const path = join(this.opts.soulDir, safe)
      if (!existsSync(path)) { sendJson(res, { error: 'not found' }, 404); return }
      sendJson(res, { file: safe, content: readFileSync(path, 'utf-8') })
    } else {
      const files = existsSync(this.opts.soulDir)
        ? readdirSync(this.opts.soulDir).filter(f => f.endsWith('.md'))
        : []
      sendJson(res, { files })
    }
  }

  private async handleSoulPost(req: HttpReq, res: ServerResponse): Promise<void> {
    if (!this.opts.soulDir) { sendJson(res, { error: 'no soul dir' }, 404); return }
    const body = JSON.parse(await readBody(req)) as { file?: string; content?: string }
    if (!body.file || body.content === undefined) { sendJson(res, { error: 'missing file/content' }, 400); return }
    const safe = basename(body.file)
    if (!safe.endsWith('.md')) { sendJson(res, { error: 'only .md' }, 400); return }
    atomicWriteFileSync(join(this.opts.soulDir, safe), body.content)
    sendJson(res, { ok: true })
  }

  // 她的面板用:意识流(签名取最后一条非空内容)
  private handleStream(res: ServerResponse): void {
    const entries = this.readJsonFile('memory/stream.md')
    sendJson(res, { entries: Array.isArray(entries) ? entries.slice(-8) : [] })
  }

  // 她的面板用:最近的知识笔记(标题 + 首段摘录)
  private handleRecentNotes(res: ServerResponse): void {
    if (!this.opts.dataDir) { sendJson(res, { notes: [] }); return }
    const dir = join(this.opts.dataDir, 'knowledge')
    if (!existsSync(dir)) { sendJson(res, { notes: [] }); return }
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
    sendJson(res, { notes })
  }

  // 她的面板用:日记最后一段(最近在写什么)
  private handleDiaryLatest(res: ServerResponse): void {
    if (!this.opts.dataDir) { sendJson(res, { entry: null }); return }
    const path = join(this.opts.dataDir, 'memory', '日记.md')
    if (!existsSync(path)) { sendJson(res, { entry: null }); return }
    const raw = readFileSync(path, 'utf-8')
    const sections = raw.split(/^## /m).filter(s => s.trim())
    const last = sections[sections.length - 1]
    if (!last) { sendJson(res, { entry: null }); return }
    const [header, ...body] = last.split('\n')
    sendJson(res, { entry: { date: header?.trim(), text: body.join('\n').trim().slice(0, 400) } })
  }

  private handleGuestbookGet(res: ServerResponse): void {
    const data = this.readJsonFile('memory/留言板.json')
    sendJson(res, { messages: Array.isArray(data) ? data.slice(-20) : [] })
  }

  // 留言会写进她家的留言板,并立刻作为事件唤醒她——有人来看她了,她该知道
  private async handleGuestbookPost(req: HttpReq, res: ServerResponse): Promise<void> {
    if (!this.opts.dataDir) { sendJson(res, { error: 'no data dir' }, 500); return }
    const body = JSON.parse(await readBody(req)) as { name?: string; text?: string }
    const text = (body.text ?? '').trim().slice(0, 500)
    if (!text) { sendJson(res, { error: 'empty' }, 400); return }
    const name = (body.name ?? '访客').trim().slice(0, 20) || '访客'
    const path = join(this.opts.dataDir, 'memory', '留言板.json')
    const list = (() => {
      try { return JSON.parse(readFileSync(path, 'utf-8')) as unknown[] } catch { return [] }
    })()
    list.push({ name, text, time: new Date().toISOString() })
    atomicWriteJsonSync(path, list.slice(-100), 2)
    this.deps.getEventHandler()?.(`留言板有新留言,${name}说: ${text}`, { name, text })
    sendJson(res, { ok: true })
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
