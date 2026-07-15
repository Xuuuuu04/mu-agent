import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DecisionJournalStore, FinanceStateError, InvestmentCaseStore } from './research-store.js'

function withDataDir(fn: (dataDir: string) => void): void {
  const dataDir = mkdtempSync(join(tmpdir(), 'mu-research-'))
  try { fn(dataDir) } finally { rmSync(dataDir, { recursive: true, force: true }) }
}

const caseInput = {
  code: '600519',
  name: '贵州茅台',
  horizon: 'long_term' as const,
  thesis: '高端白酒品牌力与现金流有持续性',
  catalysts: ['直销占比提升'],
  risks: ['需求放缓'],
  invalidation: ['核心产品批价持续下降'],
  confidence: 0.7,
  status: 'active' as const,
  review_at: '2026-08-01T00:00:00.000Z',
}

test('InvestmentCaseStore: missing state starts empty; update preserves immutable fields and evidence', () => withDataDir(dataDir => {
  let tick = 0
  const store = new InvestmentCaseStore(dataDir, {
    now: () => `2026-07-10T00:00:0${tick++}.000Z`,
    id: kind => `${kind}-stable`,
  })
  assert.deepEqual(store.listCases(), [])

  const created = store.upsertCase(caseInput)
  const evidence = store.appendEvidence(created.id, {
    source: '年报',
    as_of: '2025-12-31T00:00:00.000Z',
    kind: 'fact',
    content: '2025 年经营现金流为正',
  })
  const updated = store.upsertCase({ id: created.id, confidence: 0.8, thesis: '更新后的研究结论' })

  assert.equal(updated.id, created.id)
  assert.equal(updated.created_at, created.created_at)
  assert.equal(updated.evidence[0]?.id, evidence.id)
  assert.equal(updated.evidence[0]?.created_at, evidence.created_at)
  assert.equal(updated.updated_at, '2026-07-10T00:00:02.000Z')
  assert.equal(readFileSync(join(dataDir, 'memory', 'investment-cases.json'), 'utf8').includes('case-stable'), true)
}))

test('InvestmentCaseStore: enum, number and timestamp validation rejects invalid state', () => withDataDir(dataDir => {
  const store = new InvestmentCaseStore(dataDir)
  assert.throws(() => store.upsertCase({ ...caseInput, confidence: Number.NaN }), /confidence/)
  assert.throws(() => store.upsertCase({ ...caseInput, status: 'guessing' as never }), /status/)
  const created = store.upsertCase(caseInput)
  assert.throws(() => store.appendEvidence(created.id, {
    source: '网页', as_of: 'not-a-date', kind: 'fact', content: '数据',
  }), /as_of/)
  assert.throws(() => store.appendEvidence(created.id, {
    source: '网页', as_of: '2026-07-01T00:00:00.000Z', kind: 'rumor' as never, content: '数据',
  }), /kind/)
}))

test('InvestmentCaseStore: corrupt state fails closed and is never overwritten', () => withDataDir(dataDir => {
  const path = join(dataDir, 'memory', 'investment-cases.json')
  mkdirSync(join(dataDir, 'memory'), { recursive: true })
  writeFileSync(path, '{broken', 'utf8')
  const before = readFileSync(path, 'utf8')
  const store = new InvestmentCaseStore(dataDir)

  assert.throws(() => store.listCases(), (err: unknown) => err instanceof FinanceStateError && err.code === 'CORRUPT_STATE')
  assert.throws(() => store.upsertCase(caseInput), FinanceStateError)
  assert.equal(readFileSync(path, 'utf8'), before)
}))

test('DecisionJournalStore: records append-only linked decisions and validates action', () => withDataDir(dataDir => {
  let id = 0
  const store = new DecisionJournalStore(dataDir, {
    now: () => '2026-07-10T01:00:00.000Z',
    id: () => `decision-${++id}`,
  })
  const first = store.record({
    action: 'watch',
    rationale: '估值尚未进入目标区间',
    case_id: 'case-1',
    expected_outcome: '等待价格与基本面出现更好匹配',
    invalidation: '盈利预期下修',
    evidence_ids: ['evidence-1'],
  })
  const second = store.record({
    action: 'hold',
    rationale: '逻辑未变',
    position_id: 'p1',
    expected_outcome: '持仓观察',
    invalidation: '跌破止损',
    evidence_ids: [],
  })

  assert.deepEqual(store.list().map(item => item.id), [first.id, second.id])
  assert.equal(store.list()[0]?.timestamp, first.timestamp)
  assert.throws(() => store.record({
    action: 'guess' as never,
    rationale: '无', case_id: 'case-1', expected_outcome: '无', invalidation: '无', evidence_ids: [],
  }), /action/)
  assert.throws(() => store.record({
    action: 'buy',
    rationale: '无', expected_outcome: '无', invalidation: '无', evidence_ids: [],
  }), /case_id|position_id/)
  assert.equal(readFileSync(join(dataDir, 'memory', 'decision-journal.json'), 'utf8').includes('decision-1'), true)
}))

test('DecisionJournalStore: actionable decisions require an immutable evaluation baseline', () => withDataDir(dataDir => {
  const store = new DecisionJournalStore(dataDir, {
    now: () => '2026-07-15T01:30:00.000Z', id: () => 'decision-evaluable',
  })
  assert.throws(() => store.record({
    action: 'buy', rationale: '进入估值区间', position_id: 'p1', expected_outcome: '跑赢沪深300',
    invalidation: '盈利预期下修', evidence_ids: [],
  }), /evaluation baseline/)
  const entry = store.record({
    action: 'buy', rationale: '进入估值区间', position_id: 'p1', expected_outcome: '跑赢沪深300',
    invalidation: '盈利预期下修', evidence_ids: [], code: '688012', decision_price: 400,
    benchmark_code: '000300', benchmark_price: 4500, horizon_days: 1,
    decision_price_source: 'ifind+tencent quorum', decision_price_as_of: '2026-07-15T01:29:59.000Z',
    benchmark_source: 'tencent', benchmark_as_of: '2026-07-15T01:29:59.000Z',
  } as any)
  assert.equal((entry as any).code, '688012')
  assert.equal((entry as any).decision_price, 400)
  assert.equal((entry as any).horizon_days, 1)
  assert.equal((entry as any).due_at, '2026-07-16T01:30:00.000Z')
  assert.equal((entry as any).decision_price_source, 'ifind+tencent quorum')
}))
