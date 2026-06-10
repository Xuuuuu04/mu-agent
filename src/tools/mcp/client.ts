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

// 极简 MCP stdio 客户端。JSON-RPC over 换行分隔的 JSON,不引 SDK。
export class McpClient {
  private proc: ChildProcess | null = null
  private buffer = ''
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private config: McpServerConfig

  constructor(config: McpServerConfig) {
    this.config = config
  }

  async connect(): Promise<ToolDef[]> {
    this.proc = spawn(this.config.command, this.config.args ?? [], {
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

  private toToolDef(spec: McpToolSpec): ToolDef {
    const fullName = `${this.config.name}__${spec.name}`
    return {
      name: fullName,
      description: spec.description ?? '',
      parameters: spec.inputSchema?.properties ?? {},
      requiredKeys: spec.inputSchema?.required ?? [],
      execute: async (params): Promise<ToolResult> => {
        try {
          const res = await this.request('tools/call', {
            name: spec.name,
            arguments: params,
          }) as { content?: Array<{ type: string; text?: string }>; isError?: boolean }
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
