import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseConsolidationResult } from './consolidation.js'

// 锁住 consolidation LLM 输出的解析:分段 + "无"过滤(曾污染 user-facts)
test('解析 [事实]/[摘要]/[情绪] 三段', () => {
  const r = parseConsolidationResult([
    '[事实]',
    '- 哥哥6月20号去深圳',
    '- 哥哥喜欢喝美式',
    '[摘要]',
    '聊了出差和咖啡',
    '[情绪]',
    '轻松愉快',
  ].join('\n'))
  assert.deepEqual(r.facts, ['哥哥6月20号去深圳', '哥哥喜欢喝美式'])
  assert.equal(r.summary, '聊了出差和咖啡')
  assert.equal(r.mood, '轻松愉快')
})

test('"无/没有新事实"不当事实存(防污染)', () => {
  const r = parseConsolidationResult(['[事实]', '- 无(用户仅回复了嗯)', '- 没有新信息'].join('\n'))
  assert.deepEqual(r.facts, [])
})

test('冒号变体 事实:/摘要: 也认', () => {
  const r = parseConsolidationResult(['摘要:今天天气好', '事实:', '- 哥哥换了手机号'].join('\n'))
  assert.equal(r.summary, '今天天气好')
  assert.deepEqual(r.facts, ['哥哥换了手机号'])
})

test('没有 [摘要] 段但文本够长 → 取前200字兜底', () => {
  const long = '这是一段没有标准格式的输出'.repeat(20)
  const r = parseConsolidationResult(long)
  assert.ok(r.summary && r.summary.length <= 200)
})

test('空输入 → facts 空、summary null', () => {
  const r = parseConsolidationResult('')
  assert.deepEqual(r.facts, [])
  assert.equal(r.summary, null)
})
