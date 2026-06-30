// HTTP 小工具:读 body、整数参数兜底、JSON 响应。纯函数,无状态。
import type { IncomingMessage as HttpReq, ServerResponse } from 'node:http'

export function readBody(req: HttpReq, maxBytes = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    let bytes = 0
    let settled = false
    req.on('data', (chunk: Buffer | string) => {
      if (settled) return
      bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
      if (bytes > maxBytes) {
        settled = true
        reject(new Error(`body too large (>${maxBytes} bytes)`))
        req.destroy()
        return
      }
      body += chunk.toString()
    })
    req.on('end', () => {
      if (!settled) {
        settled = true
        resolve(body)
      }
    })
    req.on('error', (err) => {
      if (!settled) {
        settled = true
        reject(err)
      }
    })
  })
}

// 浏览器只允许同源访问；bridge/curl 不带 Origin，继续走本机回环链路。
// 这道闸阻止恶意网页借用户浏览器跨源改 soul/config 或伪造 webhook 消息。
export function isOriginAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true
  if (!host) return false
  try {
    const u = new URL(origin)
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.host === host
  } catch {
    return false
  }
}

// URL 整数参数兜底:非法/NaN 回落默认值并 clamp 到 [min,max],防 slice(-NaN) 返回整表或脏输入 500
export function clampInt(raw: string | null, def: number, min: number, max: number): number {
  const n = parseInt(raw ?? '')
  if (!Number.isFinite(n)) return def
  return Math.max(min, Math.min(max, n))
}

export function sendJson(res: ServerResponse, data: unknown, code = 200): void {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}
