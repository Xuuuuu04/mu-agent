import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchIntelligenceStore } from '../finance/research-intelligence.js'
import { MarketSessionAuditor } from './market-session-auditor.js'

test('MarketSessionAuditor accumulates boundary evidence and upserts one daily audit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shion-session-'))
  try {
    const store = new ResearchIntelligenceStore(dir)
    const audit = new MarketSessionAuditor(store)
    audit.record(new Date('2026-07-13T01:15:02Z'), 1, 0)
    audit.record(new Date('2026-07-13T01:30:04Z'), 0.98, 0)
    const state = store.snapshot()
    assert.equal(state.sessionAudits.length, 1)
    assert.deepEqual(state.sessionAudits[0]!.observed, [
      { boundary: '09:15', driftSeconds: 2 }, { boundary: '09:30', driftSeconds: 4 },
    ])
    assert.deepEqual(state.sessionAudits[0]!.missingBoundaries, ['11:30', '13:00', '14:57', '15:00'])
    assert.equal(state.sessionAudits[0]!.quoteCoverage, 0.99)
    assert.equal(state.sessionAudits[0]!.status, 'collecting')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('MarketSessionAuditor never lets an early cadence tick claim a future boundary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shion-session-early-'))
  try {
    const store = new ResearchIntelligenceStore(dir)
    const audit = new MarketSessionAuditor(store)
    audit.record(new Date('2026-07-13T01:29:06Z'), 1, 0)
    audit.record(new Date('2026-07-13T01:30:00Z'), 1, 0)
    audit.record(new Date('2026-07-13T06:58:31Z'), 1, 0)
    audit.record(new Date('2026-07-13T07:00:00Z'), 1, 0)
    const observed = store.snapshot().sessionAudits[0]!.observed
    assert.deepEqual(observed, [
      { boundary: '09:30', driftSeconds: 0 },
      { boundary: '15:00', driftSeconds: 0 },
    ])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('MarketSessionAuditor averages all coverage samples and uses half-day boundaries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shion-session-half-'))
  try {
    const store = new ResearchIntelligenceStore(dir)
    const audit = new MarketSessionAuditor(store)
    audit.record(new Date('2026-07-13T01:15:00Z'), 0, 0, true)
    audit.record(new Date('2026-07-13T01:30:00Z'), 1, 0, true)
    audit.record(new Date('2026-07-13T03:30:00Z'), 1, 0, true)
    const result = store.snapshot().sessionAudits[0]!
    assert.deepEqual(result.expected, ['09:15', '09:30', '11:30'])
    assert.equal(result.quoteCoverage, 2 / 3)
    assert.equal(result.pass, false)
    assert.equal(result.status, 'failed')
    assert.equal(result.finalizedAt, '2026-07-13T03:30:00.000Z')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('MarketSessionAuditor converts process-lifetime overlap counter to a daily delta', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shion-session-overlap-'))
  try {
    const store = new ResearchIntelligenceStore(dir)
    const audit = new MarketSessionAuditor(store)
    audit.record(new Date('2026-07-13T01:15:00Z'), 1, 7)
    audit.record(new Date('2026-07-13T01:30:00Z'), 1, 8)
    assert.equal(store.snapshot().sessionAudits[0]!.overlapSuppressed, 1)
    audit.record(new Date('2026-07-14T01:15:00Z'), 1, 8)
    assert.equal(store.snapshot().sessionAudits[1]!.overlapSuppressed, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('MarketSessionAuditor finalizes a complete full day as passed at 15:00', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shion-session-pass-'))
  try {
    const store = new ResearchIntelligenceStore(dir)
    const audit = new MarketSessionAuditor(store)
    for (const time of ['01:15:00', '01:30:00', '03:30:00', '05:00:00', '06:57:00', '07:00:00']) {
      audit.record(new Date(`2026-07-13T${time}Z`), 1, 0)
    }
    const result = store.snapshot().sessionAudits[0]!
    assert.equal(result.status, 'passed')
    assert.equal(result.pass, true)
    assert.equal(result.finalizedAt, '2026-07-13T07:00:00.000Z')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('MarketSessionAuditor finalizes failed when close tick is missed, including next-day recovery', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shion-session-missed-close-'))
  try {
    const store = new ResearchIntelligenceStore(dir)
    const audit = new MarketSessionAuditor(store)
    audit.record(new Date('2026-07-13T06:57:00Z'), 1, 0)
    audit.record(new Date('2026-07-13T07:02:00Z'), 1, 0)
    assert.equal(store.snapshot().sessionAudits[0]!.status, 'failed')
    const dir2 = mkdtempSync(join(tmpdir(), 'shion-session-next-day-'))
    try {
      const store2 = new ResearchIntelligenceStore(dir2); const audit2 = new MarketSessionAuditor(store2)
      audit2.record(new Date('2026-07-13T06:57:00Z'), 1, 0)
      audit2.record(new Date('2026-07-14T01:15:00Z'), 1, 0)
      assert.equal(store2.snapshot().sessionAudits[0]!.status, 'failed')
      assert.match(String(store2.snapshot().sessionAudits[0]!.finalizationReason), /next trading day/)
    } finally { rmSync(dir2, { recursive: true, force: true }) }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
