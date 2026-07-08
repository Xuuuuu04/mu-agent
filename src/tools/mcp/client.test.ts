// McpClient stdio 缓冲溢出自保:狂写 stdout 无换行的坏 server 必须被真正 kill,不能空转泄漏孤儿进程。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { McpClient, parseSseResult } from './client.js'
import type { McpServerConfig } from '../../core/types.js'

test('onData 溢出 → 真的 kill 子进程(先 disconnect 再 failAllPending,不空转)', () => {
  const c = new McpClient({ name: 'bad', command: 'true' } as McpServerConfig)
  const kills: string[] = []
  const fakeProc = {
    kill: (sig: string) => { kills.push(sig); return true },
    on: () => {},
    stdin: null,
  }
  // 注入假进程 + 一个在途请求,验证溢出后进程被 kill、pending 被 reject
  const internal = c as unknown as {
    proc: unknown
    pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>
    onData: (b: Buffer) => void
  }
  internal.proc = fakeProc
  let rejected: Error | null = null
  internal.pending.set(1, { resolve: () => {}, reject: (e) => { rejected = e } })

  // 8MB+ 无换行 → 抽干完整行(没有)后残段超上限 → 判协议损坏
  internal.onData(Buffer.from('x'.repeat(8 * 1024 * 1024 + 16)))

  assert.ok(kills.includes('SIGTERM'), '溢出应真的 SIGTERM 子进程,而不是命中 if(!proc)return 空转')
  assert.ok(rejected, '在途请求应被 reject(不再干等 30s 超时)')
})

test('onData 正常整行 JSON-RPC 响应 → resolve 对应 pending,不误判溢出', () => {
  const c = new McpClient({ name: 'ok', command: 'true' } as McpServerConfig)
  const internal = c as unknown as {
    pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>
    onData: (b: Buffer) => void
  }
  let resolved: unknown = null
  internal.pending.set(7, { resolve: (v) => { resolved = v }, reject: () => {} })
  internal.onData(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 7, result: { ok: 1 } }) + '\n'))
  assert.deepEqual(resolved, { ok: 1 })
})

// ── HTTP / streamable-HTTP 传输 ──

// 假 fetch:按 JSON-RPC method 分派,默认回 JSON,可切 SSE。
function fakeFetch(opts: { sse?: boolean; status?: number; resultFor?: (method: string) => unknown } = {}) {
  return (async (url: string, init: any) => {
    const req = JSON.parse(init.body as string)
    if (req.method === 'notifications/initialized') return new Response('', { status: 202 })
    const result = opts.resultFor ? opts.resultFor(req.method) : { ok: 1 }
    const payload = JSON.stringify({ jsonrpc: '2.0', id: req.id, result })
    const body = opts.sse ? `event: message\ndata: ${payload}\n\n` : payload
    return new Response(body, {
      status: opts.status ?? 200,
      headers: { 'content-type': opts.sse ? 'text/event-stream' : 'application/json' },
    })
  }) as typeof globalThis.fetch
}

test('parseSseResult:单 data 行 → 取出 id 匹配的消息', () => {
  const text = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 5, result: { a: 1 } })}\n\n`
  assert.deepEqual(parseSseResult(text, 5).result, { a: 1 })
})

test('parseSseResult:多个事件 → 挑 id 匹配的那条', () => {
  const text =
    `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'first' })}\n\n` +
    `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: 'second' })}\n\n`
  assert.equal(parseSseResult(text, 2).result, 'second')
})

test('parseSseResult:无 id 匹配 → 兜底返回最后一个(不抛)', () => {
  const text = `data: ${JSON.stringify({ jsonrpc: '2.0', id: 9, result: 'only' })}\n\n`
  assert.equal(parseSseResult(text, 999).result, 'only')
})

test('httpRequest:JSON 响应 → 返回 result', async () => {
  const c = new McpClient({ name: 's', transport: 'http', url: 'https://x/mcp' } as McpServerConfig,
    fakeFetch({ resultFor: () => ({ tools: [] }) }))
  const r = await (c as unknown as { httpRequest: (m: string, p: unknown) => Promise<unknown> }).httpRequest('tools/list', {})
  assert.deepEqual(r, { tools: [] })
})

test('httpRequest:SSE 响应 → 解析 data 返回 result', async () => {
  const c = new McpClient({ name: 's', transport: 'http', url: 'https://x/mcp' } as McpServerConfig,
    fakeFetch({ sse: true, resultFor: () => ({ tools: [{ name: 'q' }] }) }))
  const r = await (c as unknown as { httpRequest: (m: string, p: unknown) => Promise<unknown> }).httpRequest('tools/list', {})
  assert.deepEqual(r, { tools: [{ name: 'q' }] })
})

test('httpRequest:HTTP 非 2xx → 抛带状态码', async () => {
  const c = new McpClient({ name: 's', transport: 'http', url: 'https://x/mcp' } as McpServerConfig,
    fakeFetch({ status: 500 }))
  await assert.rejects(
    (c as unknown as { httpRequest: (m: string, p: unknown) => Promise<unknown> }).httpRequest('tools/list', {}),
    /HTTP 500/,
  )
})

test('httpRequest:jsonrpc error → 抛 message', async () => {
  const fetchImpl = (async () => new Response(
    JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad params' } }),
    { headers: { 'content-type': 'application/json' } },
  )) as typeof globalThis.fetch
  const c = new McpClient({ name: 's', transport: 'http', url: 'https://x/mcp' } as McpServerConfig, fetchImpl)
  await assert.rejects(
    (c as unknown as { httpRequest: (m: string, p: unknown) => Promise<unknown> }).httpRequest('tools/call', {}),
    /bad params/,
  )
})

test('http connect 全流程:initialize + tools/list → ToolDef 命名 name__tool', async () => {
  const seenHeaders: Record<string, string> = {}
  const fetchImpl = (async (url: string, init: any) => {
    Object.assign(seenHeaders, init.headers)
    const req = JSON.parse(init.body as string)
    if (req.method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2024-11-05' } }), { headers: { 'content-type': 'application/json' } })
    if (req.method === 'notifications/initialized') return new Response('', { status: 202 })
    if (req.method === 'tools/list') return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { tools: [{ name: 'quote', description: '行情', inputSchema: { properties: { code: { type: 'string' } }, required: ['code'] } }] } }), { headers: { 'content-type': 'application/json' } })
    if (req.method === 'tools/call') return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: 'price=10.5' }] } }), { headers: { 'content-type': 'application/json' } })
    return new Response('', { status: 404 })
  }) as typeof globalThis.fetch
  const c = new McpClient({ name: 'ifind', transport: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer SECRET' } } as McpServerConfig, fetchImpl)
  const tools = await c.connect()
  assert.equal(tools.length, 1)
  assert.equal(tools[0]!.name, 'ifind__quote')
  assert.equal(tools[0]!.requiredKeys!.join(), 'code')
  // Authorization 头透传到每个请求
  assert.equal(seenHeaders.Authorization, 'Bearer SECRET')
  // execute 走 http tools/call
  const out = await tools[0]!.execute({ code: '000001' }, undefined as never)
  assert.equal(out.success, true)
  assert.equal(out.output, 'price=10.5')
})

test('http 缺 url → connect 抛清晰错误', async () => {
  const c = new McpClient({ name: 's', transport: 'http' } as McpServerConfig, fakeFetch())
  await assert.rejects(c.connect(), /缺 url/)
})
