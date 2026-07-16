import { test } from 'node:test'
import assert from 'node:assert/strict'

test('CninfoAnnouncementClient caches the official mapping and normalizes announcements', async () => {
  const module = await import('./cninfo-announcements.js').catch(() => null)
  assert.ok(module, 'cninfo announcement module must exist')
  if (!module) return

  const calls: Array<{ url: string; body: string }> = []
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, body: String(init?.body ?? '') })
    if (url.endsWith('/new/data/szse_stock.json')) return new Response(JSON.stringify({ stockList: [
      { code: '688012', orgId: '9900038991' }, { code: '003816', orgId: '9900038160' },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } })
    return new Response(JSON.stringify({ totalAnnouncement: 1, announcements: [{
      announcementId: '121234', announcementTitle: '<em>重大资产重组</em>进展公告',
      announcementTime: Date.parse('2026-07-16T10:00:00+08:00'), announcementTypeName: '临时公告',
      adjunctUrl: 'finalpage/2026-07-16/121234.PDF',
    }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const client = new module.CninfoAnnouncementClient(fakeFetch as typeof fetch)
  const first = await client.fetch(['688012'], '2026-07-15', '2026-07-16')
  const second = await client.fetch(['003816'], '2026-07-15', '2026-07-16')
  assert.equal(calls.filter(call => call.url.endsWith('/new/data/szse_stock.json')).length, 1)
  assert.match(calls[1]!.body, /stock=688012%2C9900038991/)
  assert.match(calls[1]!.body, /seDate=2026-07-15%7E2026-07-16/)
  assert.deepEqual(first, [{ source: 'cninfo', title: '重大资产重组进展公告',
    publishedAt: '2026-07-16T02:00:00.000Z', url: 'https://static.cninfo.com.cn/finalpage/2026-07-16/121234.PDF',
    content: '临时公告', codeHints: ['688012'] }])
  assert.equal(second[0]?.codeHints?.[0], '003816')
})

test('CninfoAnnouncementClient fails closed on unknown codes and invalid payloads', async () => {
  const module = await import('./cninfo-announcements.js').catch(() => null)
  assert.ok(module, 'cninfo announcement module must exist')
  if (!module) return
  const unknown = new module.CninfoAnnouncementClient(async () => new Response(JSON.stringify({ stockList: [] }), { status: 200 }))
  await assert.rejects(() => unknown.fetch(['688012'], '2026-07-15', '2026-07-16'), /orgId unavailable/)
  const invalid = new module.CninfoAnnouncementClient(async (input: string | URL | Request) => String(input).includes('szse_stock')
    ? new Response(JSON.stringify({ stockList: [{ code: '688012', orgId: 'x' }] }), { status: 200 })
    : new Response(JSON.stringify({ totalAnnouncement: 1, announcements: 'not-an-array' }), { status: 200 }))
  await assert.rejects(() => invalid.fetch(['688012'], '2026-07-15', '2026-07-16'), /incomplete announcements/)
})

test('CninfoAnnouncementClient follows bounded pagination instead of silently truncating announcements', async () => {
  const module = await import('./cninfo-announcements.js')
  const pages: number[] = []
  const client = new module.CninfoAnnouncementClient(async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes('szse_stock')) return new Response(JSON.stringify({ stockList: [
      { code: '688012', orgId: '9900038991' },
    ] }), { status: 200 })
    const page = Number(new URLSearchParams(String(init?.body)).get('pageNum'))
    pages.push(page)
    const count = page === 1 ? 30 : 1
    return new Response(JSON.stringify({ totalAnnouncement: 31, announcements: Array.from({ length: count }, (_, index) => ({
      announcementTitle: `公告第${page}页-${index + 1}`,
      announcementTime: Date.parse('2026-07-16T10:00:00+08:00') + (page - 1) * 30_000 + index * 1_000,
    })) }), { status: 200 })
  })
  const events = await client.fetch(['688012'], '2026-07-15', '2026-07-16')
  assert.deepEqual(pages, [1, 2])
  assert.equal(events.length, 31)
  assert.equal(events[0]?.title, '公告第1页-1')
  assert.equal(events[30]?.title, '公告第2页-1')
})

test('CninfoAnnouncementClient fails closed when a query exceeds its bounded page capacity', async () => {
  const module = await import('./cninfo-announcements.js')
  const client = new module.CninfoAnnouncementClient(async (input: string | URL | Request) => String(input).includes('szse_stock')
    ? new Response(JSON.stringify({ stockList: [{ code: '688012', orgId: '9900038991' }] }), { status: 200 })
    : new Response(JSON.stringify({ totalAnnouncement: 121, announcements: [] }), { status: 200 }))
  await assert.rejects(() => client.fetch(['688012'], '2026-07-15', '2026-07-16'), /capacity exceeded/)
})

test('CninfoAnnouncementClient trusts only an explicit zero total as empty', async () => {
  const module = await import('./cninfo-announcements.js')
  const build = (announcementBody: object) => new module.CninfoAnnouncementClient(async (input: string | URL | Request) => String(input).includes('szse_stock')
    ? new Response(JSON.stringify({ stockList: [{ code: '688012', orgId: '9900038991' }] }), { status: 200 })
    : new Response(JSON.stringify(announcementBody), { status: 200 }))
  assert.deepEqual(await build({ totalAnnouncement: 0, announcements: null }).fetch(['688012'], '2026-07-15', '2026-07-16'), [])
  await assert.rejects(() => build({ announcements: null }).fetch(['688012'], '2026-07-15', '2026-07-16'), /invalid announcement total/)
  await assert.rejects(() => build({ totalAnnouncement: 1, announcements: null }).fetch(['688012'], '2026-07-15', '2026-07-16'), /incomplete announcements/)
})

test('CninfoAnnouncementClient rejects partial pages, malformed rows, and changing totals', async () => {
  const module = await import('./cninfo-announcements.js')
  const clientFor = (pageBody: (page: number) => object) => new module.CninfoAnnouncementClient(async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes('szse_stock')) return new Response(JSON.stringify({ stockList: [
      { code: '688012', orgId: '9900038991' },
    ] }), { status: 200 })
    return new Response(JSON.stringify(pageBody(Number(new URLSearchParams(String(init?.body)).get('pageNum')))), { status: 200 })
  })
  const valid = (title: string) => ({ announcementTitle: title, announcementTime: Date.parse('2026-07-16T10:00:00+08:00') })
  await assert.rejects(() => clientFor(() => ({ totalAnnouncement: 2, announcements: [valid('only one')] }))
    .fetch(['688012'], '2026-07-15', '2026-07-16'), /incomplete announcements/)
  await assert.rejects(() => clientFor(() => ({ totalAnnouncement: 1, announcements: [{ announcementTitle: '', announcementTime: 0 }] }))
    .fetch(['688012'], '2026-07-15', '2026-07-16'), /invalid announcement row/)
  await assert.rejects(() => clientFor(page => ({ totalAnnouncement: page === 1 ? 31 : 30,
    announcements: Array.from({ length: page === 1 ? 30 : 1 }, (_, index) => valid(`p${page}-${index}`)) }))
    .fetch(['688012'], '2026-07-15', '2026-07-16'), /announcement total changed/)
})
