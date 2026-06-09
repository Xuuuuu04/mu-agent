import type { ToolDef } from '../../core/types.js'

// web_search:优先用智谱(config.tools.web_search 配了 zhipu key),否则降级 DuckDuckGo。
// 智谱搜索对中文、实时信息强很多;DuckDuckGo 是无 key 兜底。
export const webSearchTool: ToolDef = {
  name: 'web_search',
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
      // 智谱挂了降级 DuckDuckGo
    }
    return duckduckgo(q, ctx.log)
  },
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
