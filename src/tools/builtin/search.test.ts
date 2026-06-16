import { test } from 'node:test'
import assert from 'node:assert/strict'
import { webSearchTool, minimaxSearch, bingSearch } from './search.js'
import type { MuConfig, ToolContext } from '../../core/types.js'

// search.ts 的 execute 用全局 fetch(没注入),所以这里替换 globalThis.fetch。
// 每个用例自己保存/还原,避免污染其他测试。

type FetchCall = { url: string; init?: RequestInit }

// 队列化 mock:按 fetch 调用次序消费一个 handler。handler 返回 Response-like。
function installFetch(handlers: Array<(url: string, init?: RequestInit) => Partial<Response> & { _body?: unknown }>) {
  const calls: FetchCall[] = []
  let i = 0
  const orig = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input)
    calls.push({ url, init })
    const h = handlers[Math.min(i++, handlers.length - 1)]!
    const r = h(url, init)
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      statusText: (r as { statusText?: string }).statusText ?? '',
      json: async () => (r as { _body?: unknown })._body,
      text: async () => ((r as { _body?: unknown })._body as string) ?? '',
      headers: r.headers ?? new Headers(),
    } as unknown as Response
  }) as typeof fetch
  return { calls, restore() { globalThis.fetch = orig } }
}

function baseConfig(webSearch?: NonNullable<MuConfig['tools']>['web_search']): MuConfig {
  return {
    model: { primary: { name: 'p', format: 'openai', base_url: '', api_key: '', model: 'm' } },
    scheduler: {
      min_wake_seconds: 120, max_wake_seconds: 3600, cron_fallback_seconds: 900,
      night_min_wake_seconds: 1800, night_start_hour: 0, night_end_hour: 7,
    },
    agent: { max_turns_per_cycle: 10, session_timeout_minutes: 30 },
    paths: { soul: '', data: '', tools: '' },
    tools: webSearch ? { web_search: webSearch } : undefined,
  }
}

function ctxFor(config: MuConfig) {
  const logs: string[] = []
  const ctx = { config, dataDir: '/tmp', log: (m: string) => logs.push(m) } as unknown as ToolContext
  return { ctx, logs }
}

// ---------- 降级顺序(核心) ----------

test('execute: 配 zhipu+key 且有结果 → 走智谱,不碰下游', async () => {
  const cfg = baseConfig({ provider: 'zhipu', api_key: 'k', minimax_api_key: 'mk' })
  const { ctx, logs } = ctxFor(cfg)
  const f = installFetch([
    () => ({ ok: true, _body: { search_result: [{ title: 'Z', content: 'zc', link: 'zl' }] } }),
  ])
  try {
    const r = await webSearchTool.execute({ query: 'hi' }, ctx)
    assert.equal(r.success, true)
    assert.match(r.output, /Z/)
    assert.equal(f.calls.length, 1, '只打了智谱一次')
    assert.match(f.calls[0]!.url, /web_search/)
    assert.ok(logs.some(l => l.includes('智谱搜了')))
  } finally { f.restore() }
})

test('execute: 智谱 HTTP 500 → 跳到 minimax', async () => {
  const cfg = baseConfig({ provider: 'zhipu', api_key: 'k', minimax_api_key: 'mk' })
  const { ctx } = ctxFor(cfg)
  const f = installFetch([
    () => ({ ok: false, status: 500 }),                                   // 智谱挂
    () => ({ ok: true, _body: { organic: [{ title: 'M', snippet: 'ms', link: 'ml' }] } }), // minimax
  ])
  try {
    const r = await webSearchTool.execute({ query: 'hi' }, ctx)
    assert.equal(r.success, true)
    assert.match(r.output, /M/)
    assert.equal(f.calls.length, 2)
    assert.match(f.calls[1]!.url, /coding_plan\/search/)
  } finally { f.restore() }
})

test('execute: 智谱空结果(search_result=[]) → 跳到 minimax', async () => {
  const cfg = baseConfig({ provider: 'zhipu', api_key: 'k', minimax_api_key: 'mk' })
  const { ctx } = ctxFor(cfg)
  const f = installFetch([
    () => ({ ok: true, _body: { search_result: [] } }),                   // 智谱返回空 → null
    () => ({ ok: true, _body: { organic: [{ title: 'M', snippet: 'ms', link: 'ml' }] } }),
  ])
  try {
    const r = await webSearchTool.execute({ query: 'hi' }, ctx)
    assert.match(r.output, /M/)
    assert.equal(f.calls.length, 2)
  } finally { f.restore() }
})

test('execute: 没配 zhipu(provider 非 zhipu) → 直接从 minimax 开始', async () => {
  const cfg = baseConfig({ provider: 'duckduckgo', minimax_api_key: 'mk' })
  const { ctx } = ctxFor(cfg)
  const f = installFetch([
    () => ({ ok: true, _body: { organic: [{ title: 'M', snippet: 'ms', link: 'ml' }] } }),
  ])
  try {
    const r = await webSearchTool.execute({ query: 'hi' }, ctx)
    assert.match(r.output, /M/)
    assert.equal(f.calls.length, 1, '没碰智谱')
    assert.match(f.calls[0]!.url, /coding_plan\/search/)
  } finally { f.restore() }
})

test('execute: 配 zhipu provider 但没 api_key → 跳过智谱直奔 minimax', async () => {
  const cfg = baseConfig({ provider: 'zhipu', minimax_api_key: 'mk' }) // 无 api_key
  const { ctx } = ctxFor(cfg)
  const f = installFetch([
    () => ({ ok: true, _body: { organic: [{ title: 'M', snippet: 'ms', link: 'ml' }] } }),
  ])
  try {
    const r = await webSearchTool.execute({ query: 'hi' }, ctx)
    assert.match(r.output, /M/)
    assert.match(f.calls[0]!.url, /coding_plan\/search/)
  } finally { f.restore() }
})

test('execute: minimax HTTP 错 → 跳到 bing', async () => {
  const cfg = baseConfig({ provider: 'duckduckgo', minimax_api_key: 'mk' })
  const { ctx } = ctxFor(cfg)
  const bingHtml = '<li class="b_algo"><h2><a href="http://b.com">标题B</a></h2><p>摘要B</p></li>'
  const f = installFetch([
    () => ({ ok: false, status: 502 }),                  // minimax 挂
    () => ({ ok: true, _body: bingHtml }),               // bing 直爬
  ])
  try {
    const r = await webSearchTool.execute({ query: 'hi' }, ctx)
    assert.equal(r.success, true)
    assert.match(r.output, /标题B/)
    assert.equal(f.calls.length, 2)
    assert.match(f.calls[1]!.url, /cn\.bing\.com/)
  } finally { f.restore() }
})

test('execute: minimax 空 organic → 跳到 bing', async () => {
  const cfg = baseConfig({ provider: 'duckduckgo', minimax_api_key: 'mk' })
  const { ctx } = ctxFor(cfg)
  const bingHtml = '<li class="b_algo"><h2><a href="http://b.com">标题B</a></h2><p>摘要B</p></li>'
  const f = installFetch([
    () => ({ ok: true, _body: { organic: [] } }),        // minimax 空 → null
    () => ({ ok: true, _body: bingHtml }),
  ])
  try {
    const r = await webSearchTool.execute({ query: 'hi' }, ctx)
    assert.match(r.output, /标题B/)
    assert.equal(f.calls.length, 2)
  } finally { f.restore() }
})

test('execute: 没配任何 key(tools 缺失) → 直接 bing', async () => {
  const cfg = baseConfig(undefined) // tools 整段没有
  const { ctx } = ctxFor(cfg)
  const bingHtml = '<li class="b_algo"><h2><a href="http://b.com">仅必应</a></h2><p>p</p></li>'
  const f = installFetch([
    () => ({ ok: true, _body: bingHtml }),
  ])
  try {
    const r = await webSearchTool.execute({ query: 'hi' }, ctx)
    assert.match(r.output, /仅必应/)
    assert.equal(f.calls.length, 1)
    assert.match(f.calls[0]!.url, /cn\.bing\.com/)
  } finally { f.restore() }
})

test('execute: bing 也挂(空结果)→ 落到 duckduckgo 兜底', async () => {
  const cfg = baseConfig(undefined)
  const { ctx } = ctxFor(cfg)
  const f = installFetch([
    () => ({ ok: true, _body: '<html>no b_algo here</html>' }),  // bing 抓不到结果 → null
    () => ({ ok: true, _body: { Answer: '42' } }),                // ddg
  ])
  try {
    const r = await webSearchTool.execute({ query: 'hi' }, ctx)
    assert.equal(r.success, true)
    assert.match(r.output, /答案: 42/)
    assert.equal(f.calls.length, 2)
    assert.match(f.calls[1]!.url, /duckduckgo\.com/)
  } finally { f.restore() }
})

test('execute: 全链路 throw(异常)→ 也走到 duckduckgo;ddg throw 则 success:false', async () => {
  const cfg = baseConfig({ provider: 'zhipu', api_key: 'k', minimax_api_key: 'mk' })
  const { ctx } = ctxFor(cfg)
  const f = installFetch([
    () => { throw new Error('net zhipu') },   // 智谱 throw → catch → null
    () => { throw new Error('net minimax') }, // minimax throw → null
    () => { throw new Error('net bing') },    // bing throw → null
    () => { throw new Error('net ddg') },     // ddg throw → success:false
  ])
  try {
    const r = await webSearchTool.execute({ query: 'hi' }, ctx)
    assert.equal(r.success, false)
    assert.match(r.error ?? '', /net ddg/)
    assert.equal(f.calls.length, 4, '四级全试过')
  } finally { f.restore() }
})

test('execute: 空 query 直接 success:false,不打网络', async () => {
  const cfg = baseConfig({ provider: 'zhipu', api_key: 'k', minimax_api_key: 'mk' })
  const { ctx } = ctxFor(cfg)
  const f = installFetch([() => ({ ok: true, _body: {} })])
  try {
    const r = await webSearchTool.execute({ query: '   ' }, ctx)
    assert.equal(r.success, false)
    assert.equal(r.error, '搜索词为空')
    assert.equal(f.calls.length, 0)
  } finally { f.restore() }
})

test('execute: ddg 无任何字段 → success:true 但返回"没查到"文案', async () => {
  const cfg = baseConfig(undefined)
  const { ctx } = ctxFor(cfg)
  const f = installFetch([
    () => ({ ok: true, _body: '<html>nothing</html>' }),  // bing null
    () => ({ ok: true, _body: {} }),                       // ddg 全空
  ])
  try {
    const r = await webSearchTool.execute({ query: '怪词' }, ctx)
    assert.equal(r.success, true)
    assert.match(r.output, /没查到/)
  } finally { f.restore() }
})

// ---------- minimaxSearch 单元 ----------

test('minimaxSearch: 拼 base_url + 端点,带日期格式', async () => {
  const f = installFetch([
    (url, init) => {
      assert.match(url, /^https:\/\/custom\.api\/v1\/coding_plan\/search$/)
      assert.equal(init?.method, 'POST')
      return { ok: true, _body: { organic: [
        { title: 'T1', snippet: 's1', link: 'l1', date: '2026-01-01' },
        { title: 'T2', snippet: 's2', link: 'l2' },
      ] } }
    },
  ])
  try {
    const r = await minimaxSearch('q', 'sk', 'https://custom.api/')  // 尾斜杠应被剥
    assert.ok(r)
    assert.match(r!, /1\. T1 \(2026-01-01\)/)
    assert.match(r!, /2\. T2\n/)            // 无 date 不带括号
  } finally { f.restore() }
})

test('minimaxSearch: 截断 snippet 到 200,最多 5 条', async () => {
  const long = 'x'.repeat(300)
  const organic = Array.from({ length: 8 }, (_, i) => ({ title: `T${i}`, snippet: long, link: `l${i}` }))
  const f = installFetch([() => ({ ok: true, _body: { organic } })])
  try {
    const r = await minimaxSearch('q', 'sk')
    assert.ok(r)
    assert.ok(r!.includes('T0') && r!.includes('T4'))
    assert.ok(!r!.includes('T5'), '只取前 5 条')
    // 每条 snippet 截到 200
    assert.ok(!r!.includes('x'.repeat(201)))
  } finally { f.restore() }
})

test('minimaxSearch: HTTP 非 ok → null', async () => {
  const f = installFetch([() => ({ ok: false, status: 500 })])
  try { assert.equal(await minimaxSearch('q', 'sk'), null) } finally { f.restore() }
})

test('minimaxSearch: throw → null(吞异常)', async () => {
  const f = installFetch([() => { throw new Error('boom') }])
  try { assert.equal(await minimaxSearch('q', 'sk'), null) } finally { f.restore() }
})

// ---------- bingSearch 单元(HTML 清洗) ----------

test('bingSearch: 剥 <strong> 标签 + 解 HTML 实体', async () => {
  const html = `<li class="b_algo"><h2><a href="http://e.com/p?a=1&amp;b=2">A&amp;B <strong>关键</strong>词</a></h2><p>这是 <strong>摘要</strong> &nbsp;含实体 &#65;</p></li>`
  const f = installFetch([() => ({ ok: true, _body: html })])
  try {
    const r = await bingSearch('q')
    assert.ok(r)
    assert.match(r!, /A&B 关键词/)          // <strong> 剥掉, &amp; → &
    assert.match(r!, /这是 摘要/)            // 摘要里的 strong 也剥
    assert.match(r!, /含实体 A/)             // &#65; → A
    // 注意:link 走的是裸 match,不过 stripHtml,所以 &amp; 不被解码,原样保留
    assert.match(r!, /http:\/\/e\.com\/p\?a=1&amp;b=2/)
  } finally { f.restore() }
})

test('bingSearch: 多个 b_algo,序号重排,最多 5 条', async () => {
  const block = (n: number) => `<li class="b_algo"><h2><a href="http://x/${n}">标题${n}</a></h2><p>摘要${n}</p></li>`
  const html = Array.from({ length: 7 }, (_, i) => block(i)).join('')
  const f = installFetch([() => ({ ok: true, _body: html })])
  try {
    const r = await bingSearch('q')
    assert.ok(r)
    assert.match(r!, /^1\. 标题0/)
    assert.match(r!, /5\. 标题4/)
    assert.ok(!r!.includes('标题5'), '只取前 5 块')
  } finally { f.restore() }
})

test('bingSearch: 有 b_algo 块但无 <h2> 标题 → 该块跳过,无有效块返回 null', async () => {
  const html = '<li class="b_algo"><p>只有摘要没标题</p></li>'
  const f = installFetch([() => ({ ok: true, _body: html })])
  try {
    assert.equal(await bingSearch('q'), null)
  } finally { f.restore() }
})

test('bingSearch: HTML 完全无结果块 → null', async () => {
  const f = installFetch([() => ({ ok: true, _body: '<html>空</html>' })])
  try { assert.equal(await bingSearch('q'), null) } finally { f.restore() }
})

test('bingSearch: HTTP 非 ok → null', async () => {
  const f = installFetch([() => ({ ok: false, status: 403 })])
  try { assert.equal(await bingSearch('q'), null) } finally { f.restore() }
})
