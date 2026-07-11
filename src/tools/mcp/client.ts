import { VERSION } from '../../version.js'
import { spawn, type ChildProcess } from 'node:child_process'
import type { ToolDef, ToolResult, McpServerConfig } from '../../core/types.js'

export type { McpServerConfig }

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id?: number
  result?: unknown
  error?: { code: number; message: string }
}

interface McpToolSpec {
  name: string
  description?: string
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] }
}

// 极简 MCP 客户端,不引 SDK。两种传输:
//  - stdio(默认):spawn 子进程,JSON-RPC over 换行分隔 JSON。带缓冲溢出自保(1b7d8cc)。
//  - http(streamable-HTTP):POST JSON-RPC 到 url,响应是 JSON 或 SSE。给 iFind 这类远程 HTTP MCP 用。
export class McpClient {
  private proc: ChildProcess | null = null
  private buffer = ''
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private config: McpServerConfig
  private transport: 'stdio' | 'http'
  // 测试可注入假 fetch;默认用全局 fetch(Node 22+ 内置)。
  private fetchImpl: typeof globalThis.fetch

  constructor(config: McpServerConfig, fetchImpl?: typeof globalThis.fetch) {
    this.config = config
    this.transport = config.transport === 'http' ? 'http' : 'stdio'
    this.fetchImpl = fetchImpl ?? globalThis.fetch
  }

  async connect(): Promise<ToolDef[]> {
    return this.transport === 'http' ? this.connectHttp() : this.connectStdio()
  }

  private async connectStdio(): Promise<ToolDef[]> {
    this.proc = spawn(this.config.command!, this.config.args ?? [], {
      env: { ...process.env, ...(this.config.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.proc.stdout?.on('data', (d: Buffer) => this.onData(d))
    this.proc.stderr?.on('data', () => { /* 服务器 debug 输出,忽略 */ })
    // command 写错(ENOENT)走 'error' 而非 'exit'；不监听会变 uncaughtException 崩掉整个 mu 进程
    this.proc.on('error', (err) => this.failAllPending(`mcp 进程错误: ${err.message}`))
    this.proc.on('exit', () => this.failAllPending('mcp 进程退出'))

    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mu', version: VERSION },
    })
    this.notify('notifications/initialized', {})

    const result = await this.request('tools/list', {}) as { tools?: McpToolSpec[] }
    return (result.tools ?? []).map(t => this.toToolDef(t))
  }

  // HTTP 传输:initialize(POST)→ notifications/initialized(POST,无 id)→ tools/list(POST)。
  private async connectHttp(): Promise<ToolDef[]> {
    if (!this.config.url) throw new Error(`mcp ${this.config.name}: transport=http 但缺 url`)
    await this.httpRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mu', version: VERSION },
    })
    this.httpNotify('notifications/initialized', {})
    const result = await this.httpRequest('tools/list', {}) as { tools?: McpToolSpec[] }
    return (result.tools ?? []).map(t => this.toToolDef(t))
  }

  private toToolDef(spec: McpToolSpec): ToolDef {
    const fullName = `${this.config.name}__${spec.name}`
    return {
      name: fullName,
      description: spec.description ?? '',
      parameters: spec.inputSchema?.properties ?? {},
      requiredKeys: spec.inputSchema?.required ?? [],
      execute: async (params): Promise<ToolResult> => {
        try {
          const res = (this.transport === 'http'
            ? await this.httpRequest('tools/call', { name: spec.name, arguments: params })
            : await this.request('tools/call', { name: spec.name, arguments: params })) as { content?: Array<{ type: string; text?: string }>; isError?: boolean }
          const text = (res.content ?? [])
            .map(c => c.type === 'text' ? (c.text ?? '') : JSON.stringify(c))
            .join('\n')
          return { success: !res.isError, output: text, error: res.isError ? text : undefined }
        } catch (err) {
          return { success: false, output: '', error: (err as Error).message }
        }
      },
    }
  }

  // ── HTTP/streamable-HTTP 传输 ──
  // 单响应体上限:防恶意/失控 server 回巨型包吃光内存(对标 stdio 的 MAX_BUFFER)。
  private static readonly MAX_HTTP_RESPONSE = 32 * 1024 * 1024
  private static readonly HTTP_TIMEOUT_MS = 30_000

  private async httpRequest(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params })
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), McpClient.HTTP_TIMEOUT_MS)
    let res: Response
    try {
      res = await this.fetchImpl(this.config.url!, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(this.config.headers ?? {}),
        },
        body,
        signal: ac.signal,
      })
    } catch (e) {
      clearTimeout(timer)
      throw new Error(`mcp ${this.config.name} ${method} 网络错误: ${(e as Error).message}`, { cause: e })
    }
    clearTimeout(timer)
    if (!res.ok) throw new Error(`mcp ${this.config.name} ${method} HTTP ${res.status}`)

    const len = Number(res.headers.get('content-length') ?? 0)
    if (len && len > McpClient.MAX_HTTP_RESPONSE) {
      throw new Error(`mcp ${this.config.name} ${method} 响应体 ${len} 字节超上限`)
    }
    const ct = res.headers.get('content-type') ?? ''
    const text = await res.text()
    if (text.length > McpClient.MAX_HTTP_RESPONSE) {
      throw new Error(`mcp ${this.config.name} ${method} 响应体超上限(${text.length} 字节)`)
    }
    let msg: JsonRpcResponse
    try {
      msg = ct.includes('text/event-stream') ? parseSseResult(text, id) : JSON.parse(text) as JsonRpcResponse
    } catch {
      throw new Error(`mcp ${this.config.name} ${method} 响应非合法 JSON`)
    }
    if (msg.error) throw new Error(msg.error.message)
    return msg.result
  }

  // 通知(无 id,无结果):notifications/initialized 等。POST 后不解析 body。
  private async httpNotify(method: string, params: unknown): Promise<void> {
    const body = JSON.stringify({ jsonrpc: '2.0', method, params })
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), McpClient.HTTP_TIMEOUT_MS)
    try {
      await this.fetchImpl(this.config.url!, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(this.config.headers ?? {}),
        },
        body,
        signal: ac.signal,
      })
    } catch {
      // 通知失败不致命(已 initialized 的 server 多半不需要它),吞掉。
    } finally {
      clearTimeout(timer)
    }
  }

  // 单个未换行行的上限:坏掉/乱写 stdout 且从不发换行的 server 会让 buffer 无界增长,OOM 掉整个 mu 进程
  private static readonly MAX_BUFFER = 8 * 1024 * 1024

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf-8')
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line) as JsonRpcResponse
        if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!
          this.pending.delete(msg.id)
          if (msg.error) p.reject(new Error(msg.error.message))
          else p.resolve(msg.result)
        }
      } catch { /* 非 JSON 行忽略 */ }
    }
    // 抽干所有完整行后,残段仍超上限 = 该 server 协议损坏(狂写 stdout 无换行)。断开自保,别拖垮主进程。
    if (this.buffer.length > McpClient.MAX_BUFFER) {
      console.error(`[mcp] ${this.config.name} 单行输出超 ${McpClient.MAX_BUFFER} 字节仍无换行,判协议损坏,断开`)
      this.buffer = ''
      // 顺序要紧:先 disconnect 真杀进程(此刻 this.proc 还在);failAllPending 会把 proc 置 null,
      // 若先调它,disconnect 命中 if(!proc)return 空转,狂写的子进程永不被 kill(孤儿泄漏)。
      this.disconnect()
      this.failAllPending('mcp 输出缓冲溢出(协议损坏)')
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`mcp ${method} 超时`))
        }
      }, 30000)
      // settle 时清掉 timer；reject 包装让 exit/error handler 能统一释放在途请求，不必干等 30s
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      try {
        this.send({ jsonrpc: '2.0', id, method, params })
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(e as Error)
      }
    })
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  private send(msg: unknown): void {
    if (!this.proc?.stdin) throw new Error('mcp 未连接')
    this.proc.stdin.write(JSON.stringify(msg) + '\n')
  }

  private failAllPending(msg: string): void {
    for (const p of this.pending.values()) p.reject(new Error(msg))
    this.pending.clear()
    this.proc = null
  }

  disconnect(): void {
    const proc = this.proc
    this.proc = null
    if (!proc) return
    proc.kill('SIGTERM')
    // server 忽略 SIGTERM 时兜底 SIGKILL，避免反复重启累积孤儿进程
    const t = setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* 已退出 */ } }, 3000)
    proc.on('exit', () => clearTimeout(t))
  }
}

// 解析 streamable-HTTP 的 SSE 响应:每个 `data:` 行是一条 JSON-RPC 消息,挑出 id 匹配的那条
// (一个事件可能跨多行 data:,按 SSE 规范用 \n 拼成一条载荷;这里以空行分隔事件块)。
export function parseSseResult(text: string, id: number): JsonRpcResponse {
  const events = text.split(/\n\s*\n/) // 事件之间用空行分隔
  let last: JsonRpcResponse | null = null
  for (const ev of events) {
    const dataLines = ev.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, ''))
    if (dataLines.length === 0) continue
    const payload = dataLines.join('\n')
    try {
      const msg = JSON.parse(payload) as JsonRpcResponse
      if (msg.id === id) return msg
      last = msg
    } catch { /* 非 JSON 的 data 块跳过 */ }
  }
  if (last) return last
  throw new Error('mcp SSE 响应无可用 data 载荷')
}
