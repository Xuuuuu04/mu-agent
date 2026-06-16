// 临时冒烟:真实启动 WebhookGateway,验证拆分后路由/同步窗口/留言板事件端到端没断。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WebhookGateway } from './gateway/webhook.js'

const dataDir = mkdtempSync(join(tmpdir(), 'mu-smoke-'))
mkdirSync(join(dataDir, 'memory'), { recursive: true })
writeFileSync(join(dataDir, 'memory', 'mood.json'), JSON.stringify({ current: 'calm', reason: 'x' }))

const PORT = 38219
const gw = new WebhookGateway({ port: PORT, dataDir })
let pass = 0, fail = 0
const check = (n: string, c: boolean) => { console.log(`${c ? '✓' : '✗'} ${n}`); c ? pass++ : fail++ }

const post = async (path: string, body: unknown) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: r.status, json: await r.json().catch(() => null) as Record<string, unknown> | null }
}
const get = async (path: string) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`)
  return { status: r.status, json: await r.json().catch(() => null) as Record<string, unknown> | null }
}

await gw.connect()

// 1. GET /api/status 走 AdminApi
{
  const r = await get('/api/status')
  check('GET /api/status 200 带 version', r.status === 200 && typeof r.json?.version === 'string')
  check('status 带 mood(calm)', (r.json?.mood as { current?: string })?.current === 'calm')
}

// 2. 空文本 POST /webhook/message → 400(06-10 事故防护)
{
  const r = await post('/webhook/message', { text: '   ' })
  check('空文本 POST → 400', r.status === 400)
}

// 3. 正常消息:handler 同步 resolve(模拟 cycle 跑完发回)
{
  gw.onMessage((msg) => {
    // 模拟大脑处理完同步回复
    gw.send({ target: 'webhook', reply_to: msg.id, content: [{ type: 'text', text: `收到:${(msg.content as { text: string }).text}` }] } as never)
  })
  const r = await post('/webhook/message', { text: '在吗' })
  check('正常消息拿到同步回复', r.status === 200 && r.json?.response === '收到:在吗')
}

// 4. 留言板 POST 触发 system_event(不进对话历史)
{
  let firedEvent = ''
  gw.onEvent((event) => { firedEvent = event })
  const r = await post('/api/guestbook', { name: '小明', text: '你好呀' })
  check('留言板 POST → ok', r.status === 200 && r.json?.ok === true)
  check('留言板触发 eventHandler 且事件串不变', firedEvent === '留言板有新留言,小明说: 你好呀')
}

// 5. 未知路由 404
{
  const r = await get('/nope')
  check('未知路由 → 404', r.status === 404)
}

await gw.disconnect()
rmSync(dataDir, { recursive: true, force: true })
console.log(fail === 0 ? `\n冒烟全过 (${pass})` : `\n${fail} 个失败`)
process.exit(fail === 0 ? 0 : 1)
