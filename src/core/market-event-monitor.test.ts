import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchIntelligenceStore } from '../finance/research-intelligence.js'
import { MarketEventMonitor, parseIfindNoticeEvents } from './market-event-monitor.js'

test('parseIfindNoticeEvents normalizes nested iFind output and ignores remarks', () => {
  const output = JSON.stringify({ code: 1, data: { data: JSON.stringify([
    { '公告标题': '中国广核：重大资产重组停牌公告', '公告片段内容': '证券代码 003816', '日期': '2026-07-11' },
    { '备注': 'not an event' },
  ]) } })
  assert.deepEqual(parseIfindNoticeEvents(output), [{ source: 'ifind-notice', title: '中国广核：重大资产重组停牌公告',
    content: '证券代码 003816', publishedAt: '2026-07-10T16:00:00.000Z' }])
})

test('parseIfindNoticeEvents fails closed on malformed or provider-error output', () => {
  assert.throws(() => parseIfindNoticeEvents('{bad'), /invalid iFind notice JSON/)
  assert.throws(() => parseIfindNoticeEvents(JSON.stringify({ code: 0, msg: 'rate limited' })), /rate limited/)
})

test('MarketEventMonitor deterministically alerts new held-position events once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shion-events-'))
  try {
    const sent: string[] = []
    const monitor = new MarketEventMonitor({ store: new ResearchIntelligenceStore(dir), getPositionCodes: () => ['003816'],
      fetchEvents: async () => [{ source: 'cninfo', title: '003816 重大资产重组停牌公告', publishedAt: '2026-07-11T00:00:00Z' }],
      deliverToUser: async text => { sent.push(text) }, now: () => new Date('2026-07-11T08:00:00Z') })
    await monitor.tick(); await monitor.tick()
    assert.equal(sent.length, 1)
    assert.match(sent[0]!, /不代表交易指令/)
    assert.equal(monitor.getHealthSnapshot().status, 'healthy')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('MarketEventMonitor retries an alert that failed delivery before marking it seen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shion-events-retry-'))
  try {
    const store = new ResearchIntelligenceStore(dir)
    let attempts = 0
    const monitor = new MarketEventMonitor({ store, getPositionCodes: () => ['003816'],
      fetchEvents: async () => [{ source: 'cninfo', title: '003816 重大资产重组停牌公告', publishedAt: '2026-07-11T00:00:00Z' }],
      deliverToUser: async () => { attempts++; if (attempts === 1) throw new Error('channel down') },
      now: () => new Date('2026-07-11T08:00:00Z') })
    await monitor.tick()
    assert.equal(store.snapshot().events.length, 0)
    assert.equal(monitor.getHealthSnapshot().status, 'degraded')
    await monitor.tick()
    assert.equal(attempts, 2)
    assert.equal(store.snapshot().events.length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('MarketEventMonitor partial batch failure does not redeliver the prior successful alert', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shion-events-partial-'))
  try {
    const delivered: string[] = []
    let failSecond = true
    const monitor = new MarketEventMonitor({ store: new ResearchIntelligenceStore(dir), getPositionCodes: () => ['003816'],
      fetchEvents: async () => [
        { source: 'cninfo', title: '003816 重大资产重组停牌公告 A', publishedAt: '2026-07-11T00:00:00Z' },
        { source: 'cninfo', title: '003816 立案处罚公告 B', publishedAt: '2026-07-11T00:01:00Z' },
      ], deliverToUser: async text => { if (text.includes('B') && failSecond) { failSecond = false; throw new Error('second failed') }; delivered.push(text) },
      now: () => new Date('2026-07-11T08:00:00Z') })
    await monitor.tick(); await monitor.tick()
    assert.equal(delivered.filter(text => text.includes('A')).length, 1)
    assert.equal(delivered.filter(text => text.includes('B')).length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
