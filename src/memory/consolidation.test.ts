import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseConsolidationResult, dedupeFacts } from './consolidation.js'

// ── dedupeFacts 确定性去重兜底 ──
test('dedupeFacts: 跳过与现有完全相同的事实', () => {
  const existing = '[2026-06-01] [consolidation] 哥哥6月2日答辩\n'
  assert.deepEqual(dedupeFacts(['哥哥6月2日答辩'], existing), [])
})

test('dedupeFacts: 新事实是现有事实的连续子串 → 冗余跳过', () => {
  const existing = '[2026-06-01] [consolidation] 哥哥6月2日答辩很紧张\n'
  assert.deepEqual(dedupeFacts(['哥哥6月2日答辩'], existing), [])
})

test('dedupeFacts: 保守 — 中间插了新信息(非连续)不误删', () => {
  // "在东北大学"打断连续性 → 不判重复,保留(宁可不删也不丢真事实)
  const existing = '[2026-06-01] [consolidation] 哥哥6月2日在东北大学答辩\n'
  assert.deepEqual(dedupeFacts(['哥哥6月2日答辩'], existing), ['哥哥6月2日答辩'])
})

test('dedupeFacts: 保留真正的新事实', () => {
  const existing = '[2026-06-01] [consolidation] 哥哥6月2日答辩\n'
  assert.deepEqual(dedupeFacts(['哥哥喜欢喝美式'], existing), ['哥哥喜欢喝美式'])
})

test('dedupeFacts: 超集(更完整的更新)保留', () => {
  const existing = '[2026-06-01] [consolidation] 哥哥答辩\n'
  // 新事实更长更具体,不算冗余,保留
  assert.deepEqual(dedupeFacts(['哥哥6月2日在东北大学答辩'], existing), ['哥哥6月2日在东北大学答辩'])
})

test('dedupeFacts: 同批内部也去重', () => {
  assert.deepEqual(dedupeFacts(['哥哥喜欢咖啡', '哥哥喜欢咖啡'], ''), ['哥哥喜欢咖啡'])
})

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
