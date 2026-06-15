import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeTrigger } from './trigger-format.js'
import type { WakeTrigger, IncomingMessage } from '../core/types.js'

const msg = (text: string, sender = 'abcdef123456'): IncomingMessage => ({
  id: 'm1', source: 'webhook', chat_type: 'private',
  sender: { id: sender, name: 'x' }, content: { type: 'text', text }, timestamp: 0,
})

test('message:渠道+发送者前8位+文本前20字', () => {
  const out = describeTrigger({ type: 'message', message: msg('在吗哥哥') })
  assert.match(out, /^webhook:abcdef12 "在吗哥哥"/)
})

test('各唤醒源都有可读描述', () => {
  assert.match(describeTrigger({ type: 'self_scheduled', reason: '想他了' } as WakeTrigger), /自醒:想他了/)
  assert.match(describeTrigger({ type: 'cron_fallback', reason: '链断了' } as WakeTrigger), /cron兜底:链断了/)
  assert.match(describeTrigger({ type: 'system_event', event: '留言板' } as WakeTrigger), /事件:留言板/)
  assert.match(describeTrigger({ type: 'manual', reason: '手动叫' } as WakeTrigger), /手动:手动叫/)
})
