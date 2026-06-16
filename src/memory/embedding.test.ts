import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EmbeddingService } from './embedding.js'
import type { ProviderConfig } from '../core/types.js'

const cfg = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  name: 'emb',
  format: 'openai',
  base_url: 'https://api.example.com/v1',
  api_key: 'sk-test',
  model: 'bge-m3',
  ...over,
})

// ---- available 标志 ----

test('available: 同时有 api_key 和 base_url → true', () => {
  const s = new EmbeddingService(cfg())
  assert.equal(s.available, true)
})

test('available: 没传 config → false', () => {
  const s = new EmbeddingService()
  assert.equal(s.available, false)
})

test('available: config 为 null → false', () => {
  const s = new EmbeddingService(null)
  assert.equal(s.available, false)
})

test('available: 缺 api_key → false', () => {
  const s = new EmbeddingService(cfg({ api_key: '' }))
  assert.equal(s.available, false)
})

test('available: 缺 base_url → false', () => {
  const s = new EmbeddingService(cfg({ base_url: '' }))
  assert.equal(s.available, false)
})

// ---- toBuffer / fromBuffer 往返一致 ----

test('toBuffer/fromBuffer: 往返保值', () => {
  const v = Float32Array.from([1.5, -2.25, 0, 3.125, 1e-7])
  const buf = EmbeddingService.toBuffer(v)
  const back = EmbeddingService.fromBuffer(buf)
  assert.equal(back.length, v.length)
  for (let i = 0; i < v.length; i++) assert.equal(back[i]!, v[i]!)
})

test('toBuffer: 字节长度 = 4 * 元素个数', () => {
  const v = Float32Array.from([1, 2, 3])
  const buf = EmbeddingService.toBuffer(v)
  assert.equal(buf.byteLength, 12)
})

test('fromBuffer: slice 出独立 ArrayBuffer(改原 Buffer 不影响结果)', () => {
  const v = Float32Array.from([7, 8, 9])
  const buf = EmbeddingService.toBuffer(v)
  const back = EmbeddingService.fromBuffer(buf)
  // fromBuffer 内部 slice,返回的数组应有自己的 buffer
  assert.notEqual(back.buffer, buf.buffer)
  buf.fill(0)
  assert.equal(back[0]!, 7)
})

test('toBuffer: 空数组往返不崩', () => {
  const v = new Float32Array(0)
  const back = EmbeddingService.fromBuffer(EmbeddingService.toBuffer(v))
  assert.equal(back.length, 0)
})

// ---- cosine(纯计算,无网络) ----

test('cosine: 同向向量 = 1', () => {
  const a = Float32Array.from([1, 2, 3])
  const b = Float32Array.from([2, 4, 6])
  assert.ok(Math.abs(EmbeddingService.cosine(a, b) - 1) < 1e-6)
})

test('cosine: 正交向量 = 0', () => {
  const a = Float32Array.from([1, 0])
  const b = Float32Array.from([0, 1])
  assert.equal(EmbeddingService.cosine(a, b), 0)
})

test('cosine: 维度不一致 → 0(防换模型后假高分)', () => {
  const a = Float32Array.from([1, 2, 3])
  const b = Float32Array.from([1, 2])
  assert.equal(EmbeddingService.cosine(a, b), 0)
})

test('cosine: 零向量 → 0(除零保护)', () => {
  const a = Float32Array.from([0, 0, 0])
  const b = Float32Array.from([1, 2, 3])
  assert.equal(EmbeddingService.cosine(a, b), 0)
})

// ---- embedBatch ----

test('embedBatch: 无 config → 全 null', async () => {
  const s = new EmbeddingService()
  const r = await s.embedBatch(['a', 'b'])
  assert.deepEqual(r, [null, null])
})

test('embedBatch: 空数组 → 空数组', async () => {
  const s = new EmbeddingService(cfg())
  const r = await s.embedBatch([])
  assert.deepEqual(r, [])
})
