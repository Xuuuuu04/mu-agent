// 知识笔记:写笔记 + 检索笔记。searchKnowledge 被 memory_search 和 /memory 命令共用。
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolDef } from '../../../core/types.js'
import { ensureDir } from './_shared.js'

// 知识笔记两级命中:标题(文件名)优先,内容次之。命中给"笔记名+摘录",
// 全文她自己 file_read(knowledge/xxx.md)再翻——这里只负责"想起来"。
// export 给 commands.ts 的 /memory 共用(两条检索路径保持同覆盖)
export function searchKnowledge(dataDir: string, query: string): string[] {
  const dir = join(dataDir, 'knowledge')
  if (!existsSync(dir)) return []
  const q = query.toLowerCase()
  const out: string[] = []
  const byContent: string[] = []
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.md')) continue
      const title = f.replace(/\.md$/, '')
      if (title.toLowerCase().includes(q)) {
        out.push(`《${title}》(knowledge/${f})`)
        continue
      }
      if (byContent.length >= 3) continue
      const text = readFileSync(join(dir, f), 'utf-8').slice(0, 50_000)
      if (!text.toLowerCase().includes(q)) continue
      const line = text.split('\n').find(l => l.toLowerCase().includes(q))?.trim().slice(0, 90) ?? ''
      byContent.push(`《${title}》: ${line}`)
    }
  } catch { /* 单文件读挂不影响其余三路 */ }
  return [...out.slice(0, 3), ...byContent].slice(0, 5)
}

export const knowledgeWriteTool: ToolDef = {
  name: 'knowledge_write',
  description: '把学到的东西记成笔记。浏览学习后想留个记录,以后能查',
  parameters: {
    title: { type: 'string', description: '笔记标题' },
    content: { type: 'string', description: '笔记正文' },
  },
  async execute(params, ctx) {
    const title = (params.title as string).trim()
    const slug = title.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40) || `note-${Date.now().toString(36)}`
    const notePath = join(ctx.dataDir, 'knowledge', `${slug}.md`)
    ensureDir(notePath)
    const date = new Date().toISOString().slice(0, 10)
    const doc = `# ${title}\n\n> ${date}\n\n${params.content}\n`
    writeFileSync(notePath, doc, 'utf-8')
    ctx.log(`写了笔记: ${title}`)
    return { success: true, output: `记下了《${title}》` }
  },
}
