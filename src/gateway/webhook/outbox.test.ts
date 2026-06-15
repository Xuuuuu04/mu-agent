import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Outbox } from './outbox.js'

test('push 超 50 丢最旧', () => {
  const ob = new Outbox(null)
  for (let i = 0; i < 60; i++) ob.push(`m${i}`)
  const all = ob.peek(0)
  assert.equal(all.length, 50)
  assert.equal(all[0]!.text, 'm10')   // m0..m9 被丢
})

test('take 取全部并清空', () => {
  const ob = new Outbox(null)
  ob.push('a'); ob.push('b')
  const taken = ob.take()
  assert.deepEqual(taken.map(x => x.text), ['a', 'b'])
  assert.equal(ob.peek(0).length, 0)
})

test('peek(since) 只取 id 大于 since 的', () => {
  const ob = new Outbox(null)
  ob.push('a'); ob.push('b'); ob.push('c')   // id 1,2,3
  assert.deepEqual(ob.peek(1).map(x => x.text), ['b', 'c'])
})

test('坏 JSON 文件当空队列,不崩', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mu-ob-'))
  const f = join(dir, 'outbox.json')
  writeFileSync(f, '{坏的')
  try {
    const ob = new Outbox(f)
    assert.equal(ob.peek(0).length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('落盘格式 {seq, messages} + 重启恢复 seq', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mu-ob-'))
  const f = join(dir, 'outbox.json')
  try {
    const ob1 = new Outbox(f)
    ob1.push('x'); ob1.push('y')
    const saved = JSON.parse(readFileSync(f, 'utf-8'))
    assert.equal(saved.seq, 2)
    assert.equal(saved.messages.length, 2)
    // 新实例从文件恢复,seq 接着 2,下一条 id=3
    const ob2 = new Outbox(f)
    ob2.push('z')
    assert.equal(ob2.peek(2).map((x: { text: string }) => x.text).join(''), 'z')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
