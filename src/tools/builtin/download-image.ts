// 下载网图到本地:把 URL 图片存进 data/网图/,返回相对路径供 message_send(image_path=...) 发给用户。
// 为什么需要它:mttravel/网页里的图都是 URL,message_send 只认本地路径,微信也不渲染 markdown 图。
// 不走 shell 模板(curl {{url}}):URL 里的 ?& 会被 substituteParams 的注入防护拦掉,所以做成内置工具,
// 用 fetch 直接取 + SSRF 守卫(复用 web.ts)挡私网/回环/元数据。
import { writeFileSync, mkdirSync, readdirSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolDef } from '../../core/types.js'
import { ssrfBlocked } from './web.js'

const MAX_BYTES = 5 * 1024 * 1024   // 5MB:表情/酒店缩略图够用,挡视频/大图
const KEEP = 30                      // 网图目录只留最近 30 张,防慢性磁盘堆积
const IMG_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif']

function extFromContentType(ct: string): string {
  const t = ct.toLowerCase()
  if (t.includes('jpeg') || t.includes('jpg')) return '.jpg'
  if (t.includes('png')) return '.png'
  if (t.includes('webp')) return '.webp'
  if (t.includes('gif')) return '.gif'
  return '.jpg'   // 兜底
}

// 只删图片文件,留最近 keep 张(按字典序≈时间序,文件名带时间戳)。image_gen 的 prune 只认 .png,这里多扩展名。
function pruneWebImages(dir: string, keep: number): void {
  try {
    const files = readdirSync(dir).filter(f => IMG_EXTS.some(e => f.endsWith(e))).sort()
    for (const f of files.slice(0, Math.max(0, files.length - keep))) {
      try { unlinkSync(join(dir, f)) } catch { /* 删不掉算了 */ }
    }
  } catch { /* 目录读不了算了 */ }
}

export const downloadImageTool: ToolDef = {
  name: 'download_image',
  description: '把一个图片 URL 下载到本地(data/网图/),返回本地路径。配合 message_send 的 image_path 把网上的图(美团酒店图、网页里的图)发给用户。只下图片,单张≤5MB',
  parallelSafe: true,
  parameters: {
    url: { type: 'string', description: '图片的 http(s) URL' },
    name: { type: 'string', description: '可选文件名(不带扩展名),默认按时间戳', required: false as unknown as string },
  },
  async execute(params, ctx) {
    const url = String(params.url ?? '').trim()
    if (!url) return { success: false, output: '', error: '没给 URL' }
    const blocked = ssrfBlocked(url)
    if (blocked) return { success: false, output: '', error: `URL 不允许: ${blocked}` }

    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(30_000),
        headers: { 'User-Agent': 'Mu-Agent/0.2' },
        redirect: 'follow',
      })
      if (!resp.ok) return { success: false, output: '', error: `HTTP ${resp.status}` }
      const ct = resp.headers.get('content-type') ?? ''
      // 没明说是图片的(含 html/text)拒:别把验证码页/错误页当图存
      if (!ct.toLowerCase().startsWith('image/')) {
        return { success: false, output: '', error: `不是图片(content-type: ${ct || '未知'})` }
      }
      const len = Number(resp.headers.get('content-length') ?? 0)
      if (len && len > MAX_BYTES) return { success: false, output: '', error: `图片太大(${len} 字节 > ${MAX_BYTES})` }

      const buf = Buffer.from(await resp.arrayBuffer())
      if (buf.length > MAX_BYTES) return { success: false, output: '', error: `图片太大(${buf.length} 字节)` }
      if (buf.length < 100) return { success: false, output: '', error: '图片太小/可能是空响应' }

      const dir = join(ctx.dataDir, '网图')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const base = String(params.name ?? '').trim().replace(/[^a-zA-Z0-9一-龥_-]/g, '').slice(0, 30)
        || `img-${Date.now().toString(36)}`
      const fname = `${base}${extFromContentType(ct)}`
      writeFileSync(join(dir, fname), buf)
      pruneWebImages(dir, KEEP)
      ctx.log(`下载网图: ${fname} (${(buf.length / 1024).toFixed(0)}KB)`)
      // 返回相对路径,message_send 的 resolveSafe 会以 data/ 为根解析
      return { success: true, output: `网图/${fname}` }
    } catch (err) {
      return { success: false, output: '', error: (err as Error).message }
    }
  },
}
