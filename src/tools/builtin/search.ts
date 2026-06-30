import type { ToolDef } from '../../core/types.js'

// web_search 四级降级:智谱(配了 key 且有余额)→ MiniMax(Coding Plan 套餐内,主力)
// → 必应中国结果页直爬 → DuckDuckGo。
// MiniMax 是结构化搜索 API(organic 带摘要和日期),质量优于爬 bing 页面;
// xpark 在国内,DDG 实测连不上(06-10),智谱按量计费没充值,bing 是无 key 兜底。
export const webSearchTool: ToolDef = {
  name: 'web_search',
  parallelSafe: true,
  description: '搜索引擎查询。想知道实时信息、查个东西时用',
  parameters: {
    query: { type: 'string', description: '搜索词' },
  },
  async execute(params, ctx) {
    const q = String(params.query ?? '').trim()
    if (!q) return { success: false, output: '', error: '搜索词为空' }

    const cfg = ctx.config.tools?.web_search
    if (cfg?.provider === 'zhipu' && cfg.api_key) {
      const r = await zhipuSearch(q, cfg.api_key, cfg.base_url)
      if (r) { ctx.log(`智谱搜了: ${q}`); return { success: true, output: r } }
    }
    if (cfg?.minimax_api_key) {
      const m = await minimaxSearch(q, cfg.minimax_api_key, cfg.minimax_base_url)
      if (m) { ctx.log(`搜了: ${q}`); return { success: true, output: m } }
    }
    const b = await bingSearch(q)
    if (b) { ctx.log(`搜了: ${q}`); return { success: true, output: b } }
    return duckduckgo(q, ctx.log)
  },
}

// MiniMax Coding Plan 自带搜索(mmx search query 的同一端点):响应 {organic:[{title,snippet,link,date}]}。
// export 仅供 test-search.ts 对照验证
export async function minimaxSearch(query: string, apiKey: string, baseUrl?: string): Promise<string | null> {
  try {
    const base = (baseUrl || 'https://api.minimax.chat').replace(/\/$/, '')
    const resp = await fetch(`${base}/v1/coding_plan/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ q: query }),
      signal: AbortSignal.timeout(20000),
    })
    if (!resp.ok) { console.error(`[web_search] minimax HTTP ${resp.status}`); return null }
    const data = await resp.json() as { organic?: Array<{ title?: string; snippet?: string; link?: string; date?: string }> }
    const results = data.organic ?? []
    if (results.length === 0) return null
    const lines = results.slice(0, 5).map((r, i) =>
      `${i + 1}. ${r.title ?? ''}${r.date ? ` (${r.date})` : ''}\n${(r.snippet ?? '').slice(0, 200)}\n${r.link ?? ''}`
    )
    return lines.join('\n\n').slice(0, 4000)
  } catch (err) {
    console.error(`[web_search] minimax ${(err as Error).message}`)
    return null
  }
}

// 必应中国 SERP 是单行 HTML,结果块是 <li class="b_algo">…</li>,标题/摘要里混着
// <strong> 等标签,抽出来要剥干净。href 偶尔是 bing 跳转链,不解,标题摘要才是主要价值。
// export 仅供 test-search.ts 对照验证
export async function bingSearch(query: string): Promise<string | null> {
  try {
    const resp = await fetch(`https://cn.bing.com/search?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(15000),
    })
    if (!resp.ok) { console.error(`[web_search] 必应 HTTP ${resp.status}`); return null }
    const html = await resp.text()
    const items = html.match(/<li class="b_algo"[\s\S]*?<\/li>/g)?.slice(0, 5) ?? []
    const lines: string[] = []
    for (const item of items) {
      const title = stripHtml(item.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)?.[1] ?? '')
      const link = item.match(/<h2[^>]*><a[^>]*href="([^"]+)"/)?.[1] ?? ''
      const snippet = stripHtml(item.match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '')
      if (title) lines.push(`${lines.length + 1}. ${title}\n${snippet.slice(0, 200)}\n${link}`)
    }
    if (lines.length === 0) return null
    return lines.join('\n\n').slice(0, 4000)
  } catch (err) {
    console.error(`[web_search] 必应 ${(err as Error).message}`)
    return null
  }
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&nbsp;|&ensp;|&emsp;/g, ' ')
    .trim()
}

async function zhipuSearch(query: string, apiKey: string, baseUrl?: string): Promise<string | null> {
  try {
    const base = (baseUrl || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/$/, '')
    const resp = await fetch(`${base}/web_search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ search_engine: 'search_std', search_query: query }),
      signal: AbortSignal.timeout(20000),
    })
    if (!resp.ok) { console.error(`[web_search] 智谱 HTTP ${resp.status}`); return null }
    const data = await resp.json() as { search_result?: Array<{ title?: string; content?: string; link?: string }> }
    const results = data.search_result ?? []
    if (results.length === 0) return null
    const lines = results.slice(0, 5).map((r, i) =>
      `${i + 1}. ${r.title ?? ''}\n${(r.content ?? '').slice(0, 200)}\n${r.link ?? ''}`
    )
    return lines.join('\n\n').slice(0, 4000)
  } catch (err) {
    console.error(`[web_search] 智谱 ${(err as Error).message}`)
    return null
  }
}

async function duckduckgo(q: string, log: (m: string) => void): Promise<{ success: boolean; output: string; error?: string }> {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_redirect=1&no_html=1`
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mu-Agent/0.2' }, signal: AbortSignal.timeout(15000) })
    if (!resp.ok) return { success: false, output: '', error: `HTTP ${resp.status}` }
    const data = await resp.json() as {
      AbstractText?: string; Abstract?: string; Answer?: string; Definition?: string; Heading?: string
      RelatedTopics?: Array<{ Text?: string }>
    }
    const parts: string[] = []
    if (data.Answer) parts.push(`答案: ${data.Answer}`)
    const abstract = data.AbstractText || data.Abstract
    if (abstract) parts.push(`${data.Heading ? data.Heading + ': ' : ''}${abstract}`)
    if (data.Definition) parts.push(`释义: ${data.Definition}`)
    const related = (data.RelatedTopics ?? []).filter(t => t.Text).slice(0, 5).map(t => `- ${t.Text}`)
    if (related.length > 0) { parts.push('相关:'); parts.push(...related) }
    if (parts.length === 0) return { success: true, output: `没查到"${q}"的直接结果` }
    log(`搜了: ${q}`)
    return { success: true, output: parts.join('\n').slice(0, 4000) }
  } catch (err) {
    return { success: false, output: '', error: (err as Error).message }
  }
}
