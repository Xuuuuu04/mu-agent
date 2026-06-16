import { test } from 'node:test'
import assert from 'node:assert/strict'
import { absolutizeTime } from './absolutize.js'

// 固定 now 消除时间依赖:2026-06-15 是周一(getDay()===1)
const NOW = new Date('2026-06-15T10:00:00')

test('明天/明日/明早/明晚 都换成同一个绝对日期', () => {
  const out = absolutizeTime('哥哥明天答辩', NOW)
  assert.match(out, /6月16日/)
  assert.doesNotMatch(out, /明天/)
  // 同义词归一到同一天
  for (const w of ['明日', '明早', '明晚']) {
    assert.match(absolutizeTime(`${w}见`, NOW), /6月16日/)
  }
})

test('长词优先:大后天不被后天先吃', () => {
  const out = absolutizeTime('大后天去', NOW)
  assert.match(out, /6月18日/)   // +3
  assert.doesNotMatch(out, /后天/)
})

test('大前天不被前天先吃', () => {
  assert.match(absolutizeTime('大前天', NOW), /6月12日/) // -3
})

test('后天/前天/今天/昨天 偏移正确', () => {
  assert.match(absolutizeTime('后天', NOW), /6月17日/)
  assert.match(absolutizeTime('前天', NOW), /6月13日/)
  assert.match(absolutizeTime('今天', NOW), /6月15日/)
  assert.match(absolutizeTime('昨天', NOW), /6月14日/)
})

test('下周/上周 是加锚点不是替换(原词保留)', () => {
  const next = absolutizeTime('下周一起', NOW)
  assert.match(next, /下周/)        // 原词还在
  assert.match(next, /那周/)        // 加了锚点
  const prev = absolutizeTime('上周聊过', NOW)
  assert.match(prev, /上周/)
  assert.match(prev, /那周/)
})

test('空串和无相对词原样返回', () => {
  assert.equal(absolutizeTime('', NOW), '')
  assert.equal(absolutizeTime('普通文本', NOW), '普通文本')
})
