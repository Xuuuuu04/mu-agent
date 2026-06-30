import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { join, dirname, sep } from 'node:path'
import type { ToolDef } from '../../core/types.js'

export const fileReadTool: ToolDef = {
  name: 'file_read',
  description: '读取文件内容',
  parallelSafe: true,
  parameters: {
    path: { type: 'string', description: '文件路径(相对于数据目录)' },
  },
  async execute(params, ctx) {
    const filePath = resolveSafe(ctx.dataDir, params.path as string)
    if (!filePath) {
      return { success: false, output: '', error: '路径不允许' }
    }
    if (!existsSync(filePath)) {
      return { success: false, output: '', error: '文件不存在' }
    }
    const stat = statSync(filePath)
    if (stat.size > 100_000) {
      return { success: false, output: '', error: '文件太大(>100KB)' }
    }
    const content = readFileSync(filePath, 'utf-8')
    return { success: true, output: content }
  },
}

export const fileWriteTool: ToolDef = {
  name: 'file_write',
  description: '写入文件内容',
  parameters: {
    path: { type: 'string', description: '文件路径(相对于数据目录)' },
    content: { type: 'string', description: '要写入的内容' },
  },
  async execute(params, ctx) {
    const filePath = resolveSafe(ctx.dataDir, params.path as string)
    if (!filePath) {
      return { success: false, output: '', error: '路径不允许' }
    }
    const content = params.content as string
    if (content.length > 500_000) {
      return { success: false, output: '', error: '内容太大(>500KB)' }
    }
    const dir = dirname(filePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(filePath, content, 'utf-8')
    return { success: true, output: `写入了 ${filePath}` }
  },
}

export const fileListTool: ToolDef = {
  name: 'file_list',
  description: '列出目录下的文件和文件夹',
  parallelSafe: true,
  parameters: {
    path: { type: 'string', description: '目录路径(相对于数据目录),默认为根目录', required: false as unknown as string },
  },
  async execute(params, ctx) {
    const dirPath = resolveSafe(ctx.dataDir, (params.path as string) || '.')
    if (!dirPath) {
      return { success: false, output: '', error: '路径不允许' }
    }
    if (!existsSync(dirPath)) {
      return { success: false, output: '', error: '目录不存在' }
    }
    const entries = readdirSync(dirPath, { withFileTypes: true })
    const listing = entries.map(e => {
      const suffix = e.isDirectory() ? '/' : ''
      return `${e.name}${suffix}`
    }).join('\n')
    return { success: true, output: listing || '(空目录)' }
  },
}

export function resolveSafe(base: string, relative: string): string | null {
  // 剥开头的 ./ 和 /,再剥一段多余的 data/ 前缀:base 本就是 data 目录,
  // 她常误写 data/x 落成 dataDir/data/x 双重嵌套(CLAUDE.md 记录的坑)。
  // 只剥开头一段、且要求后面带 /(data.txt 这种文件名不动)
  const rel = relative.replace(/^\.?\/+/, '').replace(/^data\//, '')
  const resolved = join(base, rel)
  // startsWith(base) 缺分隔符边界，同前缀兄弟目录(data-backup)能逃出沙箱；要求严格落在 base 下
  if (resolved !== base && !resolved.startsWith(base + sep)) return null
  return resolved
}
