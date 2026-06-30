// 长期事实 CRUD:记住(save)/ 检索(search,三路)/ 更新(update)/ 忘掉(forget)。
// 检索:user-facts → episodes+日摘要 → ima 知识库(笔记 + 订阅 KB)。
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolDef } from '../../../core/types.js'
import { absolutizeTime } from '../../../memory/absolutize.js'
import { ensureDir, fuzzyMatchLine } from './_shared.js'
import { searchKnowledgeIma } from './ima.js'
import { atomicWriteFileSync } from '../../../core/atomic-file.js'

export const memorySaveTool: ToolDef = {
  name: 'memory_save',
  description: '记住一件重要的事。用户提到的日期、承诺、偏好、健康状况、计划等都应该记住',
  parameters: {
    category: {
      type: 'string',
      description: '分类: fact(事实) / preference(偏好) / event(事件) / health(健康)',
    },
    content: { type: 'string', description: '要记住的内容' },
  },
  async execute(params, ctx) {
    const factsPath = join(ctx.dataDir, 'memory', 'user-facts.md')
    ensureDir(factsPath)

    const existing = existsSync(factsPath) ? readFileSync(factsPath, 'utf-8') : ''
    const timestamp = new Date().toISOString().slice(0, 10)
    // 固化相对时间:"明天"→"6月2日",防止过几天读到就错位
    const content = absolutizeTime(params.content as string)
    const entry = `\n[${timestamp}] [${params.category}] ${content}\n`

    atomicWriteFileSync(factsPath, existing + entry)
    ctx.log(`记住了: ${(params.content as string).slice(0, 50)}`)
    return { success: true, output: '记住了' }
  },
}

export const memorySearchTool: ToolDef = {
  name: 'memory_search',
  parallelSafe: true,
  description: '搜索过去的记忆。想回忆之前聊过的事、说过的话时用这个(事实和对话记录都会搜)',
  parameters: {
    query: { type: 'string', description: '搜索关键词' },
  },
  async execute(params, ctx) {
    const query = (params.query as string)
    const out: string[] = []

    // 第一路:长期事实(user-facts)
    const factsPath = join(ctx.dataDir, 'memory', 'user-facts.md')
    if (existsSync(factsPath)) {
      const lines = readFileSync(factsPath, 'utf-8').split('\n').filter(l => l.trim())
      const matches = lines.filter(l => l.toLowerCase().includes(query.toLowerCase()))
      if (matches.length > 0) {
        out.push('[记住的事实]')
        out.push(...matches.slice(0, 8))
      }
    }

    // 第二路:对话和日记(episodes)。以前这个工具只搜事实文件,
    // "之前聊过什么"她根本搜不到——回忆是半盲的
    if (ctx.store) {
      const rows = ctx.store.searchHybrid(query, 6)
      if (rows.length > 0) {
        out.push(out.length > 0 ? '\n[聊过的话和日记]' : '[聊过的话和日记]')
        for (const r of rows) {
          const date = r.timestamp.slice(0, 10)
          const who = r.role === 'user' ? '用户' : r.role === 'assistant' ? '我' : ''
          out.push(`[${date}]${who ? ` ${who}:` : ''} ${r.content.slice(0, 100).replace(/\n/g, ' ')}`)
        }
      }
      // 每日摘要(有些事只在摘要里)
      const sums = ctx.store.searchDailySummaries(query, 2)
      if (sums.length > 0) {
        out.push('\n[那几天的摘要]')
        for (const s of sums) out.push(`[${s.date}] ${s.summary.slice(0, 100)}`)
      }
    }

    // 第三路:ima 知识库(她自己维护的笔记 + 配置的订阅 KB)。未配置则跳过
    const noted = await searchKnowledgeIma(ctx.config?.tools?.ima, query)
    if (noted.length > 0) {
      out.push('\n[知识库]')
      out.push(...noted)
    }

    if (out.length === 0) {
      return { success: true, output: `没找到关于"${query}"的记忆` }
    }
    return { success: true, output: out.join('\n') }
  },
}

export const memoryUpdateTool: ToolDef = {
  name: 'memory_update',
  description: '更新一条已有的事实。比如用户换了手机号、改了计划,旧的记错了要改',
  parameters: {
    old: { type: 'string', description: '旧内容里的关键词(用来定位那条记忆)' },
    new: { type: 'string', description: '更新后的完整内容' },
  },
  async execute(params, ctx) {
    const factsPath = join(ctx.dataDir, 'memory', 'user-facts.md')
    if (!existsSync(factsPath)) {
      return { success: false, output: '', error: '还没有记忆可更新' }
    }
    const content = readFileSync(factsPath, 'utf-8')
    const oldKey = (params.old as string).toLowerCase()
    const lines = content.split('\n')
    // 先试整串包含;失败再降级关键词模糊匹配(measures 措辞差一点也能命中)
    let idx = lines.findIndex(l => l.toLowerCase().includes(oldKey))
    if (idx === -1) {
      idx = fuzzyMatchLine(lines, oldKey)
    }
    if (idx === -1) {
      return { success: false, output: '', error: `没找到关于"${params.old}"的记忆,可以换个关键词,或用 memory_forget 删掉旧的再 memory_save 新的` }
    }
    const date = new Date().toISOString().slice(0, 10)
    lines[idx] = `[${date}] [updated] ${absolutizeTime(params.new as string)}`
    atomicWriteFileSync(factsPath, lines.join('\n'))
    ctx.log(`更新了: ${(params.new as string).slice(0, 50)}`)
    return { success: true, output: '改好了' }
  },
}

export const memoryForgetTool: ToolDef = {
  name: 'memory_forget',
  description: '忘掉一条记忆。用户说"这个不用记了"时用',
  parameters: {
    key: { type: 'string', description: '要忘掉的记忆里的关键词' },
  },
  async execute(params, ctx) {
    const factsPath = join(ctx.dataDir, 'memory', 'user-facts.md')
    if (!existsSync(factsPath)) {
      return { success: false, output: '', error: '没有记忆' }
    }
    const content = readFileSync(factsPath, 'utf-8')
    const key = (params.key as string).toLowerCase()
    const lines = content.split('\n')
    const matched = lines.filter(l => l.trim() && l.toLowerCase().includes(key))
    if (matched.length === 0) {
      return { success: true, output: `没找到关于"${params.key}"的记忆,不用忘` }
    }
    // 命中多条不直接删：删"哥哥"这种高频词会一次清空大量无关记忆，且不可逆。让模型换更精确的关键词
    if (matched.length > 1) {
      const preview = matched.slice(0, 8).map((l, i) => `${i + 1}. ${l.trim().slice(0, 60)}`).join('\n')
      return { success: false, output: '', error: `"${params.key}" 命中 ${matched.length} 条，太宽泛不敢直接删。用更精确的关键词指定要忘的那条：\n${preview}` }
    }
    const kept = lines.filter(l => l !== matched[0])
    atomicWriteFileSync(factsPath, kept.join('\n'))
    ctx.log(`忘掉了: ${matched[0]!.trim().slice(0, 40)}`)
    return { success: true, output: '忘掉了' }
  },
}
