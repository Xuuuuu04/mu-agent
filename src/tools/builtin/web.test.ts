import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { webFetchTool, ssrfBlocked, htmlToText, setDnsLookupForTests } from './web.js'
import type { ToolContext } from '../../core/types.js'

// web_fetch.execute 直接调全局 fetch(无注入点),用替换 globalThis.fetch + finally 还原。
function withFetch(
  impl: (url: string, init: RequestInit) => Promise<unknown>,
  fn: () => Promise<void>,
): Promise<void> {
  const orig = globalThis.fetch
  globalThis.fetch = impl as unknown as typeof fetch
  return fn().finally(() => { globalThis.fetch = orig })
}

// 造一个最小 Response-like:execute 只用到 headers.get / json / text / ok / status / statusText。
function fakeResponse(opts: {
  contentType?: string
  body?: string
  json?: unknown
  ok?: boolean
  status?: number
  statusText?: string
  location?: string
}): unknown {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    statusText: opts.statusText ?? 'OK',
    headers: {
      get: (k: string) => {
        if (k.toLowerCase() === 'content-type') return opts.contentType ?? ''
        if (k.toLowerCase() === 'location') return opts.location ?? null
        return null
      },
    },
    json: async () => opts.json,
    text: async () => opts.body ?? '',
  }
}

// execute 的第二参数 ctx 没被用到,给个空壳。
const dummyCtx = {} as unknown as ToolContext

before(() => {
  setDnsLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }])
})
after(() => setDnsLookupForTests(null))

// ---------- ssrfBlocked(纯函数,导出)----------

test('ssrfBlocked: 公网 https 放行', () => {
  assert.equal(ssrfBlocked('https://example.com/path'), null)
})

test('ssrfBlocked: 非法 URL', () => {
  assert.equal(ssrfBlocked('not a url'), 'URL 格式不对')
})

test('ssrfBlocked: 非 http/https 协议被拦', () => {
  assert.equal(ssrfBlocked('ftp://example.com'), '只允许 http/https')
  assert.equal(ssrfBlocked('file:///etc/passwd'), '只允许 http/https')
})

test('ssrfBlocked: localhost / *.localhost 被拦', () => {
  assert.equal(ssrfBlocked('http://localhost:3210/'), '不允许访问本机')
  assert.equal(ssrfBlocked('http://foo.localhost/'), '不允许访问本机')
})

test('ssrfBlocked: 回环/私网/元数据 IPv4 被拦', () => {
  assert.equal(ssrfBlocked('http://127.0.0.1/'), '不允许访问私网/回环/元数据地址')
  assert.equal(ssrfBlocked('http://10.0.0.5/'), '不允许访问私网/回环/元数据地址')
  assert.equal(ssrfBlocked('http://172.16.0.1/'), '不允许访问私网/回环/元数据地址')
  assert.equal(ssrfBlocked('http://172.31.255.255/'), '不允许访问私网/回环/元数据地址')
  assert.equal(ssrfBlocked('http://192.168.1.1/'), '不允许访问私网/回环/元数据地址')
  assert.equal(ssrfBlocked('http://169.254.169.254/'), '不允许访问私网/回环/元数据地址')
  assert.equal(ssrfBlocked('http://0.0.0.0/'), '不允许访问私网/回环/元数据地址')
})

test('ssrfBlocked: 172.15 / 172.32 不在私网段,放行', () => {
  // 边界:172.16-172.31 才是私网。172.15 和 172.32 应放行。
  assert.equal(ssrfBlocked('http://172.15.0.1/'), null)
  assert.equal(ssrfBlocked('http://172.32.0.1/'), null)
})

test('ssrfBlocked: 公网 IPv4 放行', () => {
  assert.equal(ssrfBlocked('http://8.8.8.8/'), null)
  assert.equal(ssrfBlocked('http://1.2.3.4/'), null)
})

test('ssrfBlocked: IPv6 回环/私网被拦', () => {
  assert.equal(ssrfBlocked('http://[::1]/'), '不允许访问私网/回环地址')
  assert.equal(ssrfBlocked('http://[::]/'), '不允许访问私网/回环地址')
  assert.equal(ssrfBlocked('http://[fd00::1]/'), '不允许访问私网/回环地址')
  assert.equal(ssrfBlocked('http://[fe80::1]/'), '不允许访问私网/回环地址')
})

// ---------- execute ----------

test('web_fetch: ssrf 命中 → 直接失败,不发请求', async () => {
  let called = false
  await withFetch(async () => { called = true; return fakeResponse({}) }, async () => {
    const r = await webFetchTool.execute({ url: 'http://127.0.0.1/' }, dummyCtx)
    assert.equal(r.success, false)
    assert.equal(r.error, '不允许访问私网/回环/元数据地址')
    assert.equal(called, false)
  })
})

test('web_fetch:域名解析到私网时拒绝(DNS rebinding 防线)', async () => {
  let called = false
  setDnsLookupForTests(async () => [{ address: '127.0.0.1', family: 4 }])
  try {
    await withFetch(async () => { called = true; return fakeResponse({}) }, async () => {
      const r = await webFetchTool.execute({ url: 'https://attacker.example/' }, dummyCtx)
      assert.equal(r.success, false)
      assert.match(r.error ?? '', /DNS.*私网/)
      assert.equal(called, false)
    })
  } finally {
    setDnsLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }])
  }
})

test('web_fetch:公网响应重定向到本机时拒绝,不跟随第二跳', async () => {
  let calls = 0
  await withFetch(async () => {
    calls++
    return fakeResponse({ ok: false, status: 302, statusText: 'Found', location: 'http://127.0.0.1:3210/api/config' })
  }, async () => {
    const r = await webFetchTool.execute({ url: 'https://attacker.example/redirect' }, dummyCtx)
    assert.equal(r.success, false)
    assert.match(r.error ?? '', /重定向.*不允许/)
    assert.equal(calls, 1)
  })
})

test('web_fetch: text/html 去标签/脚本,返回可读正文', async () => {
  const html = '<html><body><h1>标题</h1><script>alert(1)</script><p>正文一段</p></body></html>'
  await withFetch(async () => fakeResponse({ contentType: 'text/html', body: html }), async () => {
    const r = await webFetchTool.execute({ url: 'https://example.com/' }, dummyCtx)
    assert.equal(r.success, true)
    assert.ok(r.output.includes('标题'))
    assert.ok(r.output.includes('正文一段'))
    assert.ok(!r.output.includes('<'), '无残留标签')
    assert.ok(!r.output.includes('alert(1)'), 'script 内容被删')
  })
})

// ---------- htmlToText(纯函数)----------
test('htmlToText: 删 script/style/注释', () => {
  const out = htmlToText('<style>.a{}</style><script>x()</script><!--c--><p>正文</p>')
  assert.ok(out.includes('正文'))
  assert.ok(!out.includes('x()') && !out.includes('.a{}') && !out.includes('c'))
})

test('htmlToText: 块级标签收尾换行,剥剩余标签', () => {
  const out = htmlToText('<p>第一段</p><p>第二段</p>')
  assert.match(out, /第一段\n第二段/)
  assert.ok(!out.includes('<'))
})

test('htmlToText: 解常见实体', () => {
  assert.equal(htmlToText('a&amp;b&lt;c&gt;d&nbsp;e&#39;f'), "a&b<c>d e'f")
})

test('htmlToText: 折叠多余空白', () => {
  const out = htmlToText('<div>  a   b  </div>\n\n\n\n<div>c</div>')
  assert.ok(!out.includes('   '))
  assert.ok(!/\n{3,}/.test(out))
})

test('web_fetch: content-type 含 json → JSON.stringify 美化两空格缩进', async () => {
  await withFetch(async () => fakeResponse({ contentType: 'application/json', json: { a: 1, b: [2, 3] } }), async () => {
    const r = await webFetchTool.execute({ url: 'https://api.example.com/' }, dummyCtx)
    assert.equal(r.success, true)
    assert.equal(r.output, JSON.stringify({ a: 1, b: [2, 3] }, null, 2))
    assert.match(r.output, /\n {2}"a": 1/)
  })
})

test('web_fetch: 超 20000 字符被截断并加省略标记', async () => {
  const big = 'x'.repeat(25000)
  await withFetch(async () => fakeResponse({ contentType: 'text/plain', body: big }), async () => {
    const r = await webFetchTool.execute({ url: 'https://example.com/big' }, dummyCtx)
    assert.equal(r.success, true)
    assert.ok(r.output.endsWith('\n...(内容截断)'))
    // 截断后 = 20000 个 x + 标记
    assert.equal(r.output, 'x'.repeat(20000) + '\n...(内容截断)')
  })
})

test('web_fetch: 恰好 20000 字符不截断', async () => {
  const exact = 'y'.repeat(20000)
  await withFetch(async () => fakeResponse({ contentType: 'text/plain', body: exact }), async () => {
    const r = await webFetchTool.execute({ url: 'https://example.com/exact' }, dummyCtx)
    assert.equal(r.success, true)
    assert.equal(r.output, exact)
    assert.ok(!r.output.includes('内容截断'))
  })
})

test('web_fetch: 非 2xx → success:false,output 仍带正文,error 带状态码', async () => {
  await withFetch(async () => fakeResponse({ contentType: 'text/html', body: 'Not Found', ok: false, status: 404, statusText: 'Not Found' }), async () => {
    const r = await webFetchTool.execute({ url: 'https://example.com/404' }, dummyCtx)
    assert.equal(r.success, false)
    assert.equal(r.output, 'Not Found')
    assert.equal(r.error, 'HTTP 404 Not Found')
  })
})

test('web_fetch: 非 2xx 的 JSON body 也美化后放 output', async () => {
  await withFetch(async () => fakeResponse({ contentType: 'application/json', json: { error: 'bad' }, ok: false, status: 500, statusText: 'Internal Server Error' }), async () => {
    const r = await webFetchTool.execute({ url: 'https://example.com/500' }, dummyCtx)
    assert.equal(r.success, false)
    assert.equal(r.output, JSON.stringify({ error: 'bad' }, null, 2))
    assert.equal(r.error, 'HTTP 500 Internal Server Error')
  })
})

test('web_fetch: fetch 抛错(如 abort/网络) → success:false,error 取 message', async () => {
  await withFetch(async () => { throw new Error('network down') }, async () => {
    const r = await webFetchTool.execute({ url: 'https://example.com/' }, dummyCtx)
    assert.equal(r.success, false)
    assert.equal(r.output, '')
    assert.equal(r.error, 'network down')
  })
})

test('web_fetch: method/body/headers 透传给 fetch,默认带 User-Agent', async () => {
  let seenUrl = ''
  let seenInit: RequestInit | undefined
  await withFetch(async (url: string, init: RequestInit) => {
    seenUrl = url
    seenInit = init
    return fakeResponse({ contentType: 'text/plain', body: 'ok' })
  }, async () => {
    await webFetchTool.execute(
      { url: 'https://example.com/api', method: 'POST', body: '{"x":1}', headers: { 'X-Test': '1' } },
      dummyCtx,
    )
  })
  assert.equal(seenUrl, 'https://example.com/api')
  assert.equal(seenInit!.method, 'POST')
  assert.equal(seenInit!.body, '{"x":1}')
  const h = seenInit!.headers as Record<string, string>
  assert.equal(h['User-Agent'], 'Shion-Agent/0.3')
  assert.equal(h['X-Test'], '1')
})

test('web_fetch: 不传 method 默认 GET,空 body 传 undefined', async () => {
  let seenInit: RequestInit | undefined
  await withFetch(async (_url: string, init: RequestInit) => {
    seenInit = init
    return fakeResponse({ contentType: 'text/plain', body: 'ok' })
  }, async () => {
    await webFetchTool.execute({ url: 'https://example.com/' }, dummyCtx)
  })
  assert.equal(seenInit!.method, 'GET')
  assert.equal(seenInit!.body, undefined)
})
