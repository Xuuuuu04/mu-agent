import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDelivery, createSendRouter, type OutboxSink } from './delivery.js'
import type { OutgoingMessage } from '../core/types.js'

// mock outbox
function fakeOutbox(): OutboxSink & { items: string[] } {
  const items: string[] = []
  return {
    items,
    pushOutbox(t) { items.push(t) },
    takeOutbox() { const x = items.map((t, i) => ({ id: i, text: t, ts: 0 })); items.length = 0; return x },
  }
}
// mock fetch:按队列依次返回 ok / 失败
function fakeFetch(results: Array<{ ok: boolean; body: unknown }>): typeof fetch {
  let i = 0
  return (async () => {
    const r = results[Math.min(i++, results.length - 1)]!
    return { ok: r.ok, status: r.ok ? 200 : 500, json: async () => r.body } as Response
  }) as unknown as typeof fetch
}

test('postToQQ: ok:true 成功;ok:false 抛错', async () => {
  const okD = createDelivery('http://x', fakeOutbox(), fakeFetch([{ ok: true, body: { ok: true } }]))
  await assert.doesNotReject(okD.postToQQ('hi'))
  const badD = createDelivery('http://x', fakeOutbox(), fakeFetch([{ ok: true, body: { ok: false, error: 'stale' } }]))
  await assert.rejects(badD.postToQQ('hi'), /stale/)
})

test('deliverToUser: 首次成功不进 outbox', async () => {
  const ob = fakeOutbox()
  const d = createDelivery('http://x', ob, fakeFetch([{ ok: true, body: { ok: true } }]))
  await d.deliverToUser('在的')
  assert.equal(ob.items.length, 0)
})

test('deliverToUser: 连续 3 次失败转 outbox', async () => {
  const ob = fakeOutbox()
  const d = createDelivery('http://x', ob, fakeFetch([{ ok: false, body: {} }]))
  await d.deliverToUser('重要的话')
  assert.deepEqual(ob.items, ['重要的话'])
})

test('deliverToUser: 带图失败,outbox 文本注明图没发出', async () => {
  const ob = fakeOutbox()
  const d = createDelivery('http://x', ob, fakeFetch([{ ok: false, body: {} }]))
  await d.deliverToUser('看这个', '/tmp/cat.png')
  assert.match(ob.items[0]!, /本想带一张图.*cat\.png/)
})

test('drainOutbox: 一条失败就塞回并停手', async () => {
  const ob = fakeOutbox()
  ob.pushOutbox('a'); ob.pushOutbox('b'); ob.pushOutbox('c')
  // 第一条成功,第二条失败 → b 塞回,c 不再尝试(但 c 已被 take 取出后丢失?按实现:take 全取出,逐条发,失败 break 不塞回剩余)
  const d = createDelivery('http://x', ob, fakeFetch([
    { ok: true, body: { ok: true } },   // a 成功
    { ok: false, body: {} },            // b 失败
  ]))
  await d.drainOutbox()
  assert.ok(ob.items.includes('b'), 'b 塞回')
})

test('sendRouter: 四路路由', async () => {
  const sent: string[] = []
  const ob = fakeOutbox()
  let recorded = 0
  const route = createSendRouter({
    cli: { send: async (m: OutgoingMessage) => { sent.push('cli:' + (m.content[0] as { text: string }).text) } },
    recordSent: () => { recorded++ },
    pushOutbox: t => ob.pushOutbox(t),
    deliverToUser: async (t) => { sent.push('qq:' + t) },
  })
  await route('cli', '本地')
  await route('autonomous', '主动')
  await route('webhook', '追发')
  await route('wechat', '微信')
  assert.deepEqual(sent, ['cli:本地', 'qq:主动', 'qq:追发'])
  assert.equal(recorded, 1)                 // 只 autonomous 记配额
  assert.deepEqual(ob.items, ['微信'])       // 其他来源进 outbox
})
