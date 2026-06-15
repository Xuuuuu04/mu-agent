// HTTP 小工具:读 body、整数参数兜底、JSON 响应。纯函数,无状态。
import type { IncomingMessage as HttpReq, ServerResponse } from 'node:http'

export function readBody(req: HttpReq): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
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
