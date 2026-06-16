import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractEntities } from './entities.js'

// characterization:锁 extractEntities 现在实际抽什么。
// 三条正则:《》书名、「」引用、\b[A-Z][a-zA-Z]{1,19}\b 英文专名;外加 dictionary 命中。
// 规则:term.trim() 后 length>=2 才收;结果去重(Set);最多 8 个。

test('《》书名抽取', () => {
  assert.deepEqual(extractEntities('在读《活着》'), ['活着'])
})

test('「」引用抽取', () => {
  assert.deepEqual(extractEntities('她说「想你了」'), ['想你了'])
})

test('英文专名:首字母大写、长度 2~20', () => {
  // React 命中;a(单字符)不命中;\b[A-Z][a-zA-Z]{1,19}\b
  assert.deepEqual(extractEntities('I love React'), ['React'])
})

test('英文专名:首字母小写不命中', () => {
  assert.deepEqual(extractEntities('hello world'), [])
})

test('英文专名:单个大写字母不命中(需总长>=2 由正则 {1,19} 保证,且 term>=2)', () => {
  // "I" 长度 1,正则要求 [A-Z][a-zA-Z]{1,19} → 至少 2 字符,所以 "I" 不命中
  assert.deepEqual(extractEntities('I am here'), [])
})

test('英文专名:CamelCase 整体作为一个 token', () => {
  assert.deepEqual(extractEntities('用 TypeScript 写'), ['TypeScript'])
})

test('多类型混合,顺序按正则处理顺序(书名→引用→英文)', () => {
  const out = extractEntities('读《活着》时她说「真好」用 React 记笔记')
  assert.deepEqual(out, ['活着', '真好', 'React'])
})

test('去重:同一实体多次出现只算一个', () => {
  assert.deepEqual(extractEntities('React React React'), ['React'])
})

test('term 长度 < 2 被丢弃(《》内单字)', () => {
  // 《X》→ term "X" 长度1 < 2 → 丢;但英文正则又会把 X 当大写字母?不,X 单字符 {1,19} 需 >=2 也不命中
  assert.deepEqual(extractEntities('《X》'), [])
})

test('《》内两字以上保留', () => {
  assert.deepEqual(extractEntities('《围城》'), ['围城'])
})

test('dictionary 命中:text.includes(entity) 且 entity 长度>=2', () => {
  const dict = new Set(['婷婷', '小沐'])
  const out = extractEntities('今天和婷婷聊了很久', dict)
  assert.ok(out.includes('婷婷'))
  assert.ok(!out.includes('小沐')) // 文本里没有
})

test('dictionary 单字实体(长度<2)被忽略', () => {
  const dict = new Set(['沐'])
  assert.deepEqual(extractEntities('沐在这', dict), [])
})

test('dictionary 与正则结果合并去重', () => {
  const dict = new Set(['React'])
  const out = extractEntities('用 React 写代码', dict)
  // 正则抽到 React,dictionary 也命中 React → Set 去重只一个
  assert.deepEqual(out, ['React'])
})

test('最多返回 8 个', () => {
  const text = 'Aa Bb Cc Dd Ee Ff Gg Hh Ii Jj'
  const out = extractEntities(text)
  assert.equal(out.length, 8)
})

test('空文本 → 空数组', () => {
  assert.deepEqual(extractEntities(''), [])
})

test('无 dictionary 参数也能跑(可选参数)', () => {
  assert.deepEqual(extractEntities('纯中文没有实体词'), [])
})

test('引用内超长(>20 字)不命中(正则上限 {1,20})', () => {
  const long = '这串很长很长很长很长很长很长很长很长很长很长很长字' // >20
  assert.deepEqual(extractEntities(`「${long}」`), [])
})
