import type { ToolDef } from '../../core/types.js'

export const webFetchTool: ToolDef = {
  name: 'web_fetch',
  description: '抓取网页内容或调用 HTTP API',
  parameters: {
    url: { type: 'string', description: '请求的 URL' },
    method: { type: 'string', description: 'HTTP 方法,默认 GET', required: false as unknown as string },
    body: { type: 'string', description: '请求体(POST 时)', required: false as unknown as string },
    headers: { type: 'object', description: '额外请求头', required: false as unknown as string },
  },
  async execute(params) {
    const url = params.url as string
    const blocked = ssrfBlocked(url)
    if (blocked) return { success: false, output: '', error: blocked }
    const method = (params.method as string) || 'GET'
    const body = params.body as string | undefined
    const headers = (params.headers as Record<string, string>) || {}

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 30000)

      const response = await fetch(url, {
        method,
        body: body || undefined,
        headers: {
          'User-Agent': 'Mu-Agent/0.1',
          ...headers,
        },
        signal: controller.signal,
      })

      clearTimeout(timeout)

      const contentType = response.headers.get('content-type') || ''
      let text: string

      if (contentType.includes('json')) {
        const json = await response.json()
        text = JSON.stringify(json, null, 2)
      } else {
        text = await response.text()
      }

      if (text.length > 20000) {
        text = text.slice(0, 20000) + '\n...(内容截断)'
      }

      if (!response.ok) {
        return {
          success: false,
          output: text,
          error: `HTTP ${response.status} ${response.statusText}`,
        }
      }

      return { success: true, output: text }
    } catch (err) {
      return {
        success: false,
        output: '',
        error: (err as Error).message,
      }
    }
  },
}

// SSRF 防护：模型给的 url 可能指向本机服务(:3210 webhook / :3212 send)、私网、云元数据(169.254)
export function ssrfBlocked(raw: string): string | null {
  let u: URL
  try { u = new URL(raw) } catch { return 'URL 格式不对' }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '只允许 http/https'
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return '不允许访问本机'
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    const a = parseInt(m[1]!), b = parseInt(m[2]!)
    if (a === 0 || a === 127 || a === 10 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 169 && b === 254)) return '不允许访问私网/回环/元数据地址'
  }
  if (host === '::1' || host === '::' || host.startsWith('fd') || host.startsWith('fe80')) {
    return '不允许访问私网/回环地址'
  }
  return null
}
