import type { ToolDef } from '../../core/types.js'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

type LookupResult = { address: string; family: number }
type LookupFn = (hostname: string) => Promise<LookupResult[]>

let dnsLookup: LookupFn = async (hostname) =>
  lookup(hostname, { all: true, verbatim: true }) as Promise<LookupResult[]>

// 仅测试替换 DNS；传 null 恢复真实解析。
export function setDnsLookupForTests(fn: LookupFn | null): void {
  dnsLookup = fn ?? (async (hostname) =>
    lookup(hostname, { all: true, verbatim: true }) as Promise<LookupResult[]>)
}

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
    let url = params.url as string
    const method = (params.method as string) || 'GET'
    const body = params.body as string | undefined
    const headers = (params.headers as Record<string, string>) || {}

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 30000)
      let response: Response | null = null
      let currentMethod = method
      let currentBody = body || undefined
      try {
        for (let hop = 0; hop <= 5; hop++) {
          const blocked = await publicUrlBlocked(url)
          if (blocked) {
            return {
              success: false,
              output: '',
              error: hop > 0 ? `重定向不允许: ${blocked}` : blocked,
            }
          }
          response = await fetch(url, {
            method: currentMethod,
            body: currentBody,
            headers: {
              'User-Agent': 'Shion-Agent/0.3',
              ...headers,
            },
            signal: controller.signal,
            redirect: 'manual',
          })
          const location = response.headers.get('location')
          if (response.status < 300 || response.status >= 400 || !location) break
          if (hop === 5) {
            return { success: false, output: '', error: '重定向次数过多' }
          }
          url = new URL(location, url).toString()
          if (response.status === 303
            || ((response.status === 301 || response.status === 302) && currentMethod.toUpperCase() === 'POST')) {
            currentMethod = 'GET'
            currentBody = undefined
          }
        }
      } finally {
        clearTimeout(timeout)
      }
      if (!response) return { success: false, output: '', error: '请求未执行' }

      const contentType = response.headers.get('content-type') || ''
      let text: string

      if (contentType.includes('json')) {
        const json = await response.json()
        text = JSON.stringify(json, null, 2)
      } else {
        text = await response.text()
        // text/html 去标签/脚本,返回可读正文——否则模型拿到一墙 HTML 标记,既没用又吃光上下文
        if (contentType.includes('html')) text = htmlToText(text)
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

// HTML → 可读正文:删 script/style/注释,块级标签收尾换行,剥剩余标签,解常见实体,折叠空白。
// 给模型读的是文章不是标记。轻量正则版(不引 cheerio 等重依赖)。
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|br|li|h[1-6]|tr|section|article|header|footer)\s*\/?>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
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

async function publicUrlBlocked(raw: string): Promise<string | null> {
  const direct = ssrfBlocked(raw)
  if (direct) return direct
  const host = new URL(raw).hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) return null // 字面 IP 已由 ssrfBlocked 检查
  let addresses: LookupResult[]
  try {
    addresses = await dnsLookup(host)
  } catch (err) {
    return `DNS 解析失败: ${(err as Error).message}`
  }
  if (addresses.length === 0) return 'DNS 没有返回地址'
  if (addresses.some(a => isPrivateAddress(a.address))) return 'DNS 解析到私网/回环地址'
  return null
}

function isPrivateAddress(raw: string): boolean {
  const address = raw.toLowerCase().replace(/^\[|\]$/g, '')
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1]
  const ip = mapped ?? address
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number)
    return a === 0 || a === 10 || a === 127
      || (a === 100 && b! >= 64 && b! <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b! >= 16 && b! <= 31)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || a! >= 224
  }
  return ip === '::' || ip === '::1'
    || ip.startsWith('fc') || ip.startsWith('fd')
    || /^fe[89ab]/.test(ip)
}
