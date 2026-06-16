import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MessageQueue, type QueueDeps } from './queue.js'
import type { WakeTrigger, CycleResult, OutgoingMessage, IncomingMessage } from '../core/types.js'

const settle = () => new Promise<void>(r => setTimeout(r, 30))
const result = (response: string): CycleResult =>
  ({ response, tool_calls_made: 0, tokens_used: { input: 0, output: 0 }, duration_ms: 0 })

const wmsg = (id: string, text: string, sender: string): WakeTrigger => ({
  type: 'message',
  message: {
    id, source: 'webhook', chat_type: 'private',
    sender: { id: sender, name: 'x' }, content: { type: 'text', text }, timestamp: 0,
  } as IncomingMessage,
})

interface Harness {
  q: MessageQueue
  cycleTexts: string[]
  sends: Array<{ text: string; reply_to?: string }>
  delivered: string[]
}
function harness(opts: {
  hasPending?: boolean
  response?: string
  gateFirst?: boolean
}): Harness & { releaseGate: () => void } {
  const cycleTexts: string[] = []
  const sends: Array<{ text: string; reply_to?: string }> = []
  const delivered: string[] = []
  let releaseGate = () => {}
  const gate = new Promise<void>(r => { releaseGate = r })
  let calls = 0

  const deps: QueueDeps = {
    loop: {
      runCycle: async (t: WakeTrigger) => {
        cycleTexts.push(t.type === 'message' && t.message.content.type === 'text' ? t.message.content.text : `[${t.type}]`)
        if (opts.gateFirst && calls++ === 0) await gate
        return result(opts.response ?? 'ok')
      },
    },
    webhook: {
      hasPending: () => opts.hasPending ?? true,
      send: async (m: OutgoingMessage) => {
        sends.push({ text: (m.content[0] as { text: string }).text, reply_to: m.reply_to })
      },
    },
    cli: { send: async () => {} },
    scheduler: { getStatus: () => ({ sleeping: false, nextWake: null, reason: '' }) },
    deliverToUser: async (text: string) => { delivered.push(text) },
  }
  return { q: new MessageQueue(deps), cycleTexts, sends, delivered, releaseGate }
}

test('合并:cycle 进行中堆积的同 sender 连发并进一个 cycle,被合并条回空释放', async () => {
  const h = harness({ gateFirst: true })
  h.q.push(wmsg('d0', '占位', 'sys'))     // 先占住 process(挂在 gate 上)
  await settle()
  h.q.push(wmsg('m1', 'a', 'bro'))         // 堆积
  h.q.push(wmsg('m2', 'b', 'bro'))         // 堆积,同 sender
  h.releaseGate()
  await settle()
  // d0 一个 cycle,m1+m2 合并成一个 cycle(文本 a\nb)
  assert.deepEqual(h.cycleTexts, ['占位', 'a\nb'])
  // m2 被合并 → 收到空文本释放
  assert.ok(h.sends.some(s => s.reply_to === 'm2' && s.text === ''), 'm2 空释放')
})

test('防蒸发:hasPending=false 时回复转主动推(deliverToUser),不走 webhook.send', async () => {
  const h = harness({ hasPending: false, response: '我在的呀' })
  h.q.push(wmsg('m1', '在吗', 'bro'))
  await settle()
  assert.deepEqual(h.delivered, ['我在的呀'])
})

test('回复为空仍发空文本释放 bridge', async () => {
  const h = harness({ response: '' })
  h.q.push(wmsg('m1', '在吗', 'bro'))
  await settle()
  assert.ok(h.sends.some(s => s.reply_to === 'm1' && s.text === ''))
})

test('hasPending=true 时正常同步回复(webhook.send 带正文)', async () => {
  const h = harness({ hasPending: true, response: '收到' })
  h.q.push(wmsg('m1', '在吗', 'bro'))
  await settle()
  assert.ok(h.sends.some(s => s.reply_to === 'm1' && s.text === '收到'))
  assert.equal(h.delivered.length, 0)
})
