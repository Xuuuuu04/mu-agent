import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PendingWindow } from './pending-window.js'

test('register 返回唯一 id(同毫秒并发不碰撞)', () => {
  const w = new PendingWindow(50)
  const a = w.register()
  const b = w.register()
  assert.notEqual(a.id, b.id)
  assert.match(a.id, /^wh_/)
  // 收尾:resolve 掉避免悬空
  w.resolve(a.id, ''); w.resolve(b.id, '')
})

test('resolve 把 promise 解析为给定文本,之后 has 为 false', async () => {
  const w = new PendingWindow(50)
  const { id, promise } = w.register()
  assert.ok(w.has(id))
  assert.equal(w.resolve(id, '在的呀'), true)
  assert.equal(await promise, '在的呀')
  assert.equal(w.has(id), false)
})

test('resolve 未知 id 返回 false', () => {
  const w = new PendingWindow(50)
  assert.equal(w.resolve('不存在', 'x'), false)
})

test('超时返回空字符串(不是占位符)', async () => {
  const w = new PendingWindow(20)
  const { id, promise } = w.register()
  assert.equal(await promise, '')
  assert.equal(w.has(id), false)
})
