import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryConsolidation, parseConsolidationResult, dedupeFacts, semanticDedupeFacts } from './consolidation.js'
import { EmbeddingService } from './embedding.js'
import type { MemoryStore } from './store.js'
import type { ModelRouter } from '../providers/router.js'

// ── consolidate 并发互斥(防两个 postProcess 重叠导致 appendFacts lost-update)──
test('consolidate: 前一轮未完成时,第二次直接跳过、不再打 router', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mu-consol-'))
  mkdirSync(join(dataDir, 'memory'), { recursive: true })
  try {
    let chatCalls = 0
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const store = {
      getUnconsolidated: () => [{ id: 'e1', timestamp: new Date().toISOString(), role: 'user', content: 'x' }],
      markConsolidated: () => {},
      upsertDailySummary: () => {},
    } as unknown as MemoryStore
    const router = {
      chat: async () => {
        chatCalls++
        await gate   // 卡住第一次,人为制造重叠窗口
        return { id: 'r', content: [{ type: 'text', text: '[事实]\n- 新事实A' }], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } }
      },
    } as unknown as ModelRouter

    const c = new MemoryConsolidation(store, router, dataDir)
    const p1 = c.consolidate()          // 卡在 gate
    const r2 = await c.consolidate()     // 第二次:consolidating=true → 立即返回,不打 router
    assert.deepEqual(r2, { factsExtracted: 0, summariesCreated: 0 })
    assert.equal(chatCalls, 1, '并发第二次不该再打 router(避免并发 appendFacts)')
    release()
    await p1
    // 释放后,标志复位,新的一次可以正常跑
    const r3 = await c.consolidate()
    assert.equal(chatCalls, 2, '第一次完成后,后续 consolidate 恢复正常')
    void r3
  } finally { rmSync(dataDir, { recursive: true, force: true }) }
})

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

// ── semanticDedupeFacts(用 mock embedding 测纯逻辑) ──

// 构造一个假 embedding service:按 vecMap 映射文本→向量,不走网络
function mockEmbedding(vecMap: Record<string, number[]>): EmbeddingService {
  return {
    available: true,
    embedBatch: async (texts: string[]) =>
      texts.map(t => {
        const key = Object.keys(vecMap).find(k => t.includes(k))
        return key ? Float32Array.from(vecMap[key]!) : null
      }),
  } as unknown as EmbeddingService
}

test('semanticDedupeFacts: 高相似度事实被过滤', async () => {
  const emb = mockEmbedding({
    '哥哥喜欢咖啡': [1, 0, 0],
    '哥哥爱喝咖啡': [0.99, 0.14, 0],     // cosine ≈ 0.99,语义重复
    '哥哥去深圳出差': [0, 1, 0],           // 正交,完全不同
  })
  const result = await semanticDedupeFacts(
    ['哥哥爱喝咖啡', '哥哥去深圳出差'],
    ['[2026-06-01] [consolidation] 哥哥喜欢咖啡'],
    emb,
  )
  assert.deepEqual(result, ['哥哥去深圳出差'])
})

test('semanticDedupeFacts: 低于阈值全保留', async () => {
  const emb = mockEmbedding({
    '哥哥喜欢咖啡': [1, 0, 0],
    '哥哥去深圳出差': [0.5, 0.866, 0],   // cosine ≈ 0.5
    '哥哥换了手机': [0, 1, 0],
  })
  const result = await semanticDedupeFacts(
    ['哥哥去深圳出差', '哥哥换了手机'],
    ['[2026-06-01] [consolidation] 哥哥喜欢咖啡'],
    emb,
  )
  assert.deepEqual(result, ['哥哥去深圳出差', '哥哥换了手机'])
})

test('semanticDedupeFacts: embedding 全挂 → 降级全放行', async () => {
  const emb = {
    available: true,
    embedBatch: async (texts: string[]) => texts.map(() => null),
  } as unknown as EmbeddingService
  const result = await semanticDedupeFacts(
    ['哥哥爱喝咖啡'],
    ['[2026-06-01] [consolidation] 哥哥喜欢咖啡'],
    emb,
  )
  assert.deepEqual(result, ['哥哥爱喝咖啡'])
})

test('semanticDedupeFacts: 空 existing → 全保留', async () => {
  const emb = mockEmbedding({})
  const result = await semanticDedupeFacts(['新事实'], [], emb)
  assert.deepEqual(result, ['新事实'])
})

test('semanticDedupeFacts: 空 newFacts → 空', async () => {
  const emb = mockEmbedding({})
  const result = await semanticDedupeFacts([], ['existing'], emb)
  assert.deepEqual(result, [])
})

test('semanticDedupeFacts: 自定义阈值生效', async () => {
  const emb = mockEmbedding({
    '哥哥喜欢咖啡': [1, 0, 0],
    '哥哥爱喝咖啡': [0.9, 0.436, 0],   // cosine ≈ 0.9
  })
  // 0.95 阈值 → 0.9 不够,保留
  const kept = await semanticDedupeFacts(
    ['哥哥爱喝咖啡'],
    ['[2026-06-01] [consolidation] 哥哥喜欢咖啡'],
    emb, 0.95,
  )
  assert.deepEqual(kept, ['哥哥爱喝咖啡'])
  // 0.80 阈值 → 0.9 足够,过滤
  const filtered = await semanticDedupeFacts(
    ['哥哥爱喝咖啡'],
    ['[2026-06-01] [consolidation] 哥哥喜欢咖啡'],
    emb, 0.80,
  )
  assert.deepEqual(filtered, [])
})

test('semanticDedupeFacts: 部分 embedding 失败的条目保留(不误删)', async () => {
  const emb = {
    available: true,
    embedBatch: async (texts: string[]) =>
      texts.map((t, i) => {
        if (t.includes('咖啡')) return Float32Array.from([1, 0, 0])
        if (i === texts.length - 1) return null  // 最后一条新事实 embed 失败
        return Float32Array.from([0, 1, 0])
      }),
  } as unknown as EmbeddingService
  const result = await semanticDedupeFacts(
    ['embed失败的事实'],
    ['[2026-06-01] [consolidation] 哥哥喜欢咖啡'],
    emb,
  )
  assert.deepEqual(result, ['embed失败的事实'])
})
