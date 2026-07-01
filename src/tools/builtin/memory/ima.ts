// ima 知识库:Shion 自己维护(笔记)+ 检索(笔记 + 配置的 KB)。
// 替换本地 data/knowledge。走 ima OpenAPI(https://ima.qq.com),凭据在 config.tools.ima。
// 纯函数(buildNoteSave/formatNoteHits/formatKbHits)单测;imaPost 是网络不单测。
import type { ToolDef, MuConfig } from '../../../core/types.js'

export type ImaConfig = NonNullable<NonNullable<MuConfig['tools']>['ima']>

const DEFAULT_BASE = 'https://ima.qq.com'

export function imaConfigured(cfg?: ImaConfig): cfg is ImaConfig {
  return !!(cfg && cfg.client_id && cfg.api_key)
}

// 调 ima OpenAPI。凭据走 header,只发往 ima.qq.com。code≠0 抛错(msg 带出)。
export async function imaPost(
  cfg: ImaConfig,
  apiPath: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const base = (cfg.base_url || DEFAULT_BASE).replace(/\/+$/, '')
  const resp = await fetch(`${base}/${apiPath}`, {
    method: 'POST',
    headers: {
      'ima-openapi-clientid': cfg.client_id,
      'ima-openapi-apikey': cfg.api_key,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const text = await resp.text()
  let json: { code?: number; msg?: string; data?: Record<string, unknown> }
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`ima 非 JSON 响应(${resp.status}): ${text.slice(0, 120)}`)
  }
  if (json.code !== 0) throw new Error(`ima ${apiPath} code=${json.code} ${json.msg ?? ''}`)
  return json.data ?? {}
}

// 纯函数:构造写笔记请求。有 note_id 走 append_doc(追加),否则 import_doc(新建,正文带 # 标题)。
export function buildNoteSave(
  title: string,
  content: string,
  noteId?: string,
): { apiPath: string; body: Record<string, unknown> } {
  if (noteId) {
    return {
      apiPath: 'openapi/note/v1/append_doc',
      body: { note_id: noteId, content_format: 1, content: `\n\n${content}` },
    }
  }
  const t = title.trim()
  const md = t ? `# ${t}\n\n${content}` : content
  return { apiPath: 'openapi/note/v1/import_doc', body: { content_format: 1, content: md } }
}

// 纯函数:search_note 响应 → 展示行。带 note_id,方便 append。
export function formatNoteHits(data: Record<string, unknown>, max = 3): string[] {
  const infos = (data?.search_note_infos as Array<Record<string, unknown>>) ?? []
  return infos.slice(0, max).map((it) => {
    const nb = (it?.note_book_info as Record<string, unknown>) ?? {}
    const title = (nb.title as string) || '(无标题)'
    const summary = String(nb.summary ?? '').replace(/\s+/g, ' ').slice(0, 80)
    return `《${title}》${summary ? ': ' + summary : ''} [note:${nb.note_id ?? ''}]`
  })
}

// 纯函数:search_knowledge 响应 → 展示行。跳过文件夹(media_type=99),去 <em> 高亮标签。
export function formatKbHits(data: Record<string, unknown>, kbName: string, max = 2): string[] {
  const list = (data?.info_list as Array<Record<string, unknown>>) ?? []
  return list
    .filter((it) => it?.media_type !== 99)
    .slice(0, max)
    .map((it) => {
      const hl = String(it?.highlight_content ?? '')
        .replace(/<\/?em>/g, '')
        .replace(/\s+/g, ' ')
        .slice(0, 80)
      return `[${kbName}] ${it?.title ?? ''}${hl ? ': ' + hl : ''}`
    })
}

// 检索:她的笔记(正文)+ 配置的 KB(并行)。任一源挂了跳过,不致命。替换本地 searchKnowledge。
export async function searchKnowledgeIma(cfg: ImaConfig | undefined, query: string): Promise<string[]> {
  if (!imaConfigured(cfg)) return []
  const out: string[] = []
  try {
    const data = await imaPost(cfg, 'openapi/note/v1/search_note', {
      search_type: 1,
      query_info: { content: query },
      start: 0,
      end: 5,
    })
    out.push(...formatNoteHits(data, 3))
  } catch (e) {
    // 静默返回 [] 会让"检索故障"和"确实没记忆"无法区分(半盲检索的老坑),生产里必须留痕
    console.warn(`[ima] 笔记检索失败(非无结果): ${(e as Error).message}`)
  }

  const kbs = cfg.knowledge_bases ?? []
  const kbHits = await Promise.all(
    kbs.map(async (kb) => {
      try {
        const data = await imaPost(cfg, 'openapi/wiki/v1/search_knowledge', {
          query,
          knowledge_base_id: kb.id,
          cursor: '',
        })
        return formatKbHits(data, kb.name, 2)
      } catch (e) {
        console.warn(`[ima] 知识库「${kb.name}」检索失败(非无结果): ${(e as Error).message}`)
        return [] as string[]
      }
    }),
  )
  for (const hits of kbHits) out.push(...hits)
  return out.slice(0, 8)
}

export const knowledgeWriteTool: ToolDef = {
  name: 'knowledge_write',
  description:
    '把学到/想长期记住的知识存进你的 ima 知识库(笔记)。以后用 memory_search 能查回来。新建笔记留空 note_id;往已有笔记追加则填它的 note_id(从 memory_search 结果里拿)',
  parameters: {
    title: { type: 'string', description: '笔记标题(新建时必填)' },
    content: { type: 'string', description: '笔记正文(markdown)' },
    note_id: {
      type: 'string',
      description: '追加到已有笔记时填它的 id;新建留空',
      required: false as unknown as string,
    },
  },
  async execute(params, ctx) {
    const cfg = ctx.config?.tools?.ima
    if (!imaConfigured(cfg)) {
      return { success: false, output: '', error: 'ima 知识库未配置(config.tools.ima)' }
    }
    const title = String(params.title ?? '').trim()
    const content = String(params.content ?? '').trim()
    if (!content) return { success: false, output: '', error: '内容为空' }
    const noteId = String(params.note_id ?? '').trim() || undefined
    const { apiPath, body } = buildNoteSave(title, content, noteId)
    try {
      await imaPost(cfg, apiPath, body)
      ctx.log(`知识入库: ${title || content.slice(0, 20)}`)
      return { success: true, output: noteId ? '追加好了' : `记下了《${title}》` }
    } catch (e) {
      return { success: false, output: '', error: (e as Error).message }
    }
  },
}
