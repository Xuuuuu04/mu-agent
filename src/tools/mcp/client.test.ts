// McpClient stdio 缓冲溢出自保:狂写 stdout 无换行的坏 server 必须被真正 kill,不能空转泄漏孤儿进程。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { McpClient } from './client.js'
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
