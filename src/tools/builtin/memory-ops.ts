import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { ToolDef, Commitment } from '../../core/types.js'
import { absolutizeTime } from '../../memory/absolutize.js'

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

    writeFileSync(factsPath, existing + entry, 'utf-8')
    ctx.log(`记住了: ${(params.content as string).slice(0, 50)}`)
    return { success: true, output: '记住了' }
  },
}

export const memorySearchTool: ToolDef = {
  name: 'memory_search',
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
          const who = r.role === 'user' ? '哥哥' : r.role === 'assistant' ? '我' : ''
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

    // 第三路:重要档案(婷婷的事/我们之间/哥哥说过的)。这些在 xiaomu-home 里,
    // 不进 episodes,以前任何检索都摸不到——"香港"这种关键事实就藏在这里
    const archives = ['婷婷的事-哥哥给我的记录.md', '我们之间.md', '哥哥说过的.md', '近期记忆.md']
    for (const name of archives) {
      const p = join(ctx.dataDir, 'xiaomu-home', name)
      if (!existsSync(p)) continue
      const matched = readFileSync(p, 'utf-8').split('\n')
        .filter(l => l.trim() && l.includes(query))
      if (matched.length > 0) {
        out.push(`\n[档案·${name.replace('.md', '')}]`)
        out.push(...matched.slice(0, 3).map(l => l.trim().slice(0, 110)))
      }
    }

    // 第四路:她自己的知识笔记(data/knowledge/ 270+ 篇)。identity 承诺"想起来会翻出来用",
    // 但之前没有任何检索通路——笔记等于写进抽屉,聊到张居正想不起自己写过白银货币化
    const noted = searchKnowledge(ctx.dataDir, query)
    if (noted.length > 0) {
      out.push('\n[我的笔记]')
      out.push(...noted)
    }

    if (out.length === 0) {
      return { success: true, output: `没找到关于"${query}"的记忆` }
    }
    return { success: true, output: out.join('\n') }
  },
}

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

export const commitmentCreateTool: ToolDef = {
  name: 'commitment_create',
  description: '创建一个承诺或提醒。答应了要做的事、需要定期做的事用这个',
  parameters: {
    content: { type: 'string', description: '承诺内容' },
    type: { type: 'string', description: 'one-time(一次性) 或 recurring(周期性)' },
    due: { type: 'string', description: '截止日期(YYYY-MM-DD),周期性可不填', required: false as unknown as string },
    schedule: { type: 'string', description: '周期说明(如"每天中午"),一次性可不填', required: false as unknown as string },
  },
  async execute(params, ctx) {
    const commitmentsPath = join(ctx.dataDir, 'memory', 'commitments.json')
    ensureDir(commitmentsPath)

    const existing: Commitment[] = existsSync(commitmentsPath)
      ? JSON.parse(readFileSync(commitmentsPath, 'utf-8'))
      : []

    const commitment: Commitment = {
      id: `c${Date.now().toString(36)}`,
      content: absolutizeTime(params.content as string),
      type: params.type as 'one-time' | 'recurring',
      due: params.due as string | undefined,
      schedule: params.schedule as string | undefined,
      status: 'active',
      created: new Date().toISOString().slice(0, 10),
    }

    existing.push(commitment)
    writeFileSync(commitmentsPath, JSON.stringify(existing, null, 2), 'utf-8')
    ctx.log(`承诺记下了: ${commitment.content}`)
    return { success: true, output: `记下了: ${commitment.content}` }
  },
}

export const commitmentDoneTool: ToolDef = {
  name: 'commitment_done',
  description: '标记一个承诺已完成',
  parameters: {
    id: { type: 'string', description: '承诺 ID' },
  },
  async execute(params, ctx) {
    const commitmentsPath = join(ctx.dataDir, 'memory', 'commitments.json')
    if (!existsSync(commitmentsPath)) {
      return { success: false, output: '', error: '没有承诺记录' }
    }

    const commitments: Commitment[] = JSON.parse(readFileSync(commitmentsPath, 'utf-8'))
    const target = commitments.find(c => c.id === params.id)
    if (!target) {
      return { success: false, output: '', error: `找不到承诺 ${params.id}` }
    }

    if (target.type === 'one-time') {
      target.status = 'done'
    }
    target.last_done = new Date().toISOString()

    writeFileSync(commitmentsPath, JSON.stringify(commitments, null, 2), 'utf-8')
    return { success: true, output: `完成了: ${target.content}` }
  },
}

export const streamNoteTool: ToolDef = {
  name: 'stream_note',
  description: '给自己的意识流写一条备注,下次醒来能看到',
  parameters: {
    note: { type: 'string', description: '备注内容' },
    activity_type: {
      type: 'string',
      description: '活动类型: learning/browsing/writing/task/chat/rest/other',
      required: false as unknown as string,
    },
  },
  async execute(params) {
    return {
      success: true,
      output: `备注: ${params.note}`,
      _stream_entry: { content: params.note, activity_type: params.activity_type },
    } as ToolResult & { _stream_entry: { content: string; activity_type?: string } }
  },
}

export const memoryUpdateTool: ToolDef = {
  name: 'memory_update',
  description: '更新一条已有的事实。比如哥哥换了手机号、改了计划,旧的记错了要改',
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
    writeFileSync(factsPath, lines.join('\n'), 'utf-8')
    ctx.log(`更新了: ${(params.new as string).slice(0, 50)}`)
    return { success: true, output: '改好了' }
  },
}

export const memoryForgetTool: ToolDef = {
  name: 'memory_forget',
  description: '忘掉一条记忆。哥哥说"这个不用记了"时用',
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
    writeFileSync(factsPath, kept.join('\n'), 'utf-8')
    ctx.log(`忘掉了: ${matched[0]!.trim().slice(0, 40)}`)
    return { success: true, output: '忘掉了' }
  },
}

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

type ToolResult = { success: boolean; output: string; error?: string }

function ensureDir(filePath: string): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

// 关键词模糊匹配:整句对不上时,提取关键 token(航班号/中文词)找匹配最多的行
function fuzzyMatchLine(lines: string[], oldKey: string): number {
  const tokens = extractKeyTokens(oldKey)
  if (tokens.length === 0) return -1
  let best = -1
  let bestScore = 0
  lines.forEach((l, i) => {
    if (!l.trim()) return
    const ll = l.toLowerCase()
    const score = tokens.filter(t => ll.includes(t)).length
    if (score > bestScore) { bestScore = score; best = i }
  })
  // 至少命中一半关键词才算找到,避免乱匹配
  return bestScore >= Math.max(1, Math.ceil(tokens.length / 2)) ? best : -1
}

function extractKeyTokens(text: string): string[] {
  const tokens: string[] = []
  // 字母数字组合:航班号 CZ6309、车次、型号等,辨识度高
  for (const t of text.match(/[a-z0-9]{2,}/gi) ?? []) tokens.push(t.toLowerCase())
  // 中文:连续中文段,长段切成 2 字 token
  for (const seg of text.match(/[一-龥]{2,}/g) ?? []) {
    if (seg.length <= 4) tokens.push(seg)
    else for (let i = 0; i < seg.length - 1; i += 2) tokens.push(seg.slice(i, i + 2))
  }
  return [...new Set(tokens)].filter(t => t.length >= 2)
}
