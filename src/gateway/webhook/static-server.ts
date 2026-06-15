// 静态文件服务(她的 Web 小房间)。注意目录逃逸防护是安全敏感点。
import { readFileSync, existsSync } from 'node:fs'
import { join, extname, sep } from 'node:path'
import type { ServerResponse } from 'node:http'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

export function serveStatic(webDir: string, pathname: string, res: ServerResponse): void {
  let filePath = pathname === '/' ? '/index.html' : pathname
  filePath = join(webDir, filePath)
  // startsWith(dir) 缺分隔符边界,同前缀兄弟目录(web-evil)能绕过;要求严格落在 dir 下
  if (filePath !== webDir && !filePath.startsWith(webDir + sep)) { res.writeHead(403); res.end(); return }
  if (!existsSync(filePath)) { res.writeHead(404); res.end('Not Found'); return }
  const mime = MIME_TYPES[extname(filePath)] || 'application/octet-stream'
  // 先读再写头:readFileSync 抛错(文件刚被删/变目录)时还没 writeHead(200),外层 catch 能干净处理
  const data = readFileSync(filePath)
  res.writeHead(200, { 'Content-Type': mime })
  res.end(data)
}

// 给测试用:判断 pathname 解析后是否落在 webDir 内(目录逃逸防护逻辑)
export function isPathInside(webDir: string, pathname: string): boolean {
  const filePath = join(webDir, pathname === '/' ? '/index.html' : pathname)
  return filePath === webDir || filePath.startsWith(webDir + sep)
}
