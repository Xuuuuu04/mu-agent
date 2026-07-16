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

test('MarketEventMonitor does not rewrite the store for an unchanged duplicate event', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shion-events-noop-write-'))
  try {
    const store = new ResearchIntelligenceStore(dir)
    const ingest = store.ingestEvents.bind(store)
    let writes = 0
    store.ingestEvents = (...args) => { writes++; return ingest(...args) }
    const monitor = new MarketEventMonitor({ store, getPositionCodes: () => ['003816'],
      fetchEvents: async () => [{ source: 'cninfo', title: '003816 普通公告', publishedAt: '2026-07-11T00:00:00Z' }],
      deliverToUser: async () => {}, now: () => new Date('2026-07-11T08:00:00Z') })
    await monitor.tick(); await monitor.tick()
    assert.equal(writes, 1)
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

test('MarketEventMonitor skips external sources in the Beijing quiet window and exposes the next check', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shion-events-quiet-'))
  try {
    let fetches = 0
    const monitor = new MarketEventMonitor({ store: new ResearchIntelligenceStore(dir), getPositionCodes: () => ['003816'],
      fetchEvents: async () => { fetches++; return [] }, deliverToUser: async () => {},
      now: () => new Date('2026-07-11T15:45:00Z') }) // 北京 23:45
    await monitor.tick()
    const health = monitor.getHealthSnapshot() as Record<string, unknown>
    assert.equal(fetches, 0)
    assert.equal(health.status, 'idle')
    assert.equal(health.skipped_reason, 'quiet_window')
    assert.equal(health.next_check_at, '2026-07-11T23:00:00.000Z') // 次日北京 07:00
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('MarketEventMonitor uses exact Beijing 07:00 inclusive and 23:30 exclusive boundaries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shion-events-boundaries-'))
  try {
    let now = new Date('2026-07-10T22:59:00Z') // 北京 06:59
    let fetches = 0
    const monitor = new MarketEventMonitor({ store: new ResearchIntelligenceStore(dir), getPositionCodes: () => ['003816'],
      fetchEvents: async () => { fetches++; return [] }, deliverToUser: async () => {}, now: () => now })
    await monitor.tick()
    assert.equal(fetches, 0)
    now = new Date('2026-07-10T23:00:00Z') // 北京 07:00
    await monitor.tick()
    assert.equal(fetches, 1)
    now = new Date('2026-07-11T15:29:00Z') // 北京 23:29
    await monitor.tick()
    assert.equal(fetches, 2)
    now = new Date('2026-07-11T15:30:00Z') // 北京 23:30
    await monitor.tick()
    assert.equal(fetches, 2)
    assert.equal(monitor.getHealthSnapshot().skipped_reason, 'quiet_window')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('MarketEventMonitor stop cancels the scheduled generation after an immediate start tick', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shion-events-lifecycle-'))
  try {
    let fetches = 0
    const monitor = new MarketEventMonitor({ store: new ResearchIntelligenceStore(dir), getPositionCodes: () => ['003816'],
      fetchEvents: async () => { fetches++; return [] }, deliverToUser: async () => {}, intervalMs: 1,
      now: () => new Date('2026-07-11T08:00:00Z') })
    monitor.start()
    await new Promise(resolve => setTimeout(resolve, 20))
    monitor.stop()
    await new Promise(resolve => setTimeout(resolve, 1_050))
    assert.equal(fetches, 1)
    assert.equal(monitor.getHealthSnapshot().next_check_at, null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('MarketEventMonitor uses its fallback only when the primary source fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shion-events-fallback-'))
  try {
    let fallbackCalls = 0
    const monitor = new MarketEventMonitor({ store: new ResearchIntelligenceStore(dir), getPositionCodes: () => ['003816'],
      fetchEvents: async () => { throw new Error('primary malformed') },
      fallbackFetchEvents: async () => { fallbackCalls++; return [] },
      deliverToUser: async () => {}, now: () => new Date('2026-07-11T08:00:00Z') } as never)
    await monitor.tick()
    assert.equal(fallbackCalls, 1)
    assert.equal(monitor.getHealthSnapshot().status, 'degraded')
    assert.equal((monitor.getHealthSnapshot() as Record<string, unknown>).last_source, 'fallback')
    assert.equal(monitor.getHealthSnapshot().last_success_at, '2026-07-11T08:00:00.000Z')

    const noNews = new MarketEventMonitor({ store: new ResearchIntelligenceStore(dir), getPositionCodes: () => ['003816'],
      fetchEvents: async () => [], fallbackFetchEvents: async () => { fallbackCalls++; return [] },
      deliverToUser: async () => {}, now: () => new Date('2026-07-11T08:00:00Z') } as never)
    await noNews.tick()
    assert.equal(fallbackCalls, 1)
    assert.equal(noNews.getHealthSnapshot().status, 'healthy')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('MarketEventMonitor retains both source errors when primary and fallback fail', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shion-events-double-failure-'))
  try {
    const monitor = new MarketEventMonitor({ store: new ResearchIntelligenceStore(dir), getPositionCodes: () => ['003816'],
      fetchEvents: async () => { throw new Error('cninfo timeout') },
      fallbackFetchEvents: async () => { throw new Error('ifind malformed') },
      deliverToUser: async () => {}, now: () => new Date('2026-07-11T08:00:00Z') })
    await monitor.tick()
    assert.match(monitor.getHealthSnapshot().last_error ?? '', /cninfo timeout/)
    assert.match(monitor.getHealthSnapshot().last_error ?? '', /ifind malformed/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('MarketEventMonitor preserves the last source failure while quiet instead of painting it green', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shion-events-quiet-error-'))
  try {
    let now = new Date('2026-07-11T08:00:00Z')
    const monitor = new MarketEventMonitor({ store: new ResearchIntelligenceStore(dir), getPositionCodes: () => ['003816'],
      fetchEvents: async () => { throw new Error('official source down') }, deliverToUser: async () => {}, now: () => now })
    await monitor.tick()
    assert.equal(monitor.getHealthSnapshot().status, 'degraded')
    now = new Date('2026-07-11T15:45:00Z')
    await monitor.tick()
    const health = monitor.getHealthSnapshot()
    assert.equal(health.status, 'idle')
    assert.equal(health.last_error, 'official source down')
    assert.equal(health.last_success_at, null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('MarketEventMonitor does not redeliver one announcement when fallback precedes official recovery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shion-events-cross-source-'))
  try {
    let primaryDown = true
    const delivered: string[] = []
    const store = new ResearchIntelligenceStore(dir)
    const ingest = store.ingestEvents.bind(store)
    let writes = 0
    store.ingestEvents = (...args) => { writes++; return ingest(...args) }
    const monitor = new MarketEventMonitor({ store, getPositionCodes: () => ['003816'],
      fetchEvents: async () => {
        if (primaryDown) throw new Error('cninfo unavailable')
        return [{ source: 'cninfo', title: '003816 重大资产重组停牌公告',
          publishedAt: '2026-07-11T02:31:00Z', url: 'https://static.cninfo.com.cn/a.pdf', codeHints: ['003816'] }]
      }, fallbackFetchEvents: async () => [{ source: 'ifind-notice', title: '003816 重大资产重组停牌公告',
        publishedAt: '2026-07-10T16:00:00Z', codeHints: ['003816'] }],
      deliverToUser: async text => { delivered.push(text) }, now: () => new Date('2026-07-11T08:00:00Z') })
    await monitor.tick()
    primaryDown = false
    await monitor.tick()
    assert.equal(delivered.length, 1)
    const events = new ResearchIntelligenceStore(dir).snapshot().events
    assert.equal(events.length, 1)
    assert.equal(events[0]?.url, 'https://static.cninfo.com.cn/a.pdf')
    assert.equal(writes, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
