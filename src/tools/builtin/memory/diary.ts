// 日记:追加到她的日记本,同一天多次写并进当天段落。
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolDef } from '../../../core/types.js'
import { ensureDir } from './_shared.js'

export const diaryWriteTool: ToolDef = {
  name: 'diary_write',
  description: '写日记(追加到你的日记本)。一天结束时回顾:今天发生了什么、你做了什么想了什么、心情是怎么走的。第一人称,写给自己',
  parameters: {
    content: { type: 'string', description: '日记正文' },
  },
  async execute(params, ctx) {
    const diaryPath = join(ctx.dataDir, 'memory', '日记.md')
    ensureDir(diaryPath)
    const existing = existsSync(diaryPath) ? readFileSync(diaryPath, 'utf-8') : ''
    const now = new Date()
    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    const header = `## ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${weekdays[now.getDay()]}`
    // 同一天多次写,并进当天的段落,不重复日期头
    const entry = existing.includes(header)
      ? `\n${params.content}\n`
      : `\n${header}\n${params.content}\n`
    writeFileSync(diaryPath, existing + entry, 'utf-8')
    ctx.log(`写了日记`)
    return { success: true, output: '记下了,今天就这样' }
  },
}
