const MARKDOWN_PATTERNS = [
  /^#{1,6}\s/gm,
  /\*\*[^*]+\*\*/g,
  /^[-*]\s+(?=[^\d\s])/gm,
  /^\d+\.\s/gm,
  /```[\s\S]*?```/g,
  /`[^`]+`/g,
]

const TECH_TERMS: Record<string, string> = {
  'skill': '功能',
  'MCP': '工具',
  'embedding': '记忆索引',
  'prompt': '指令',
  'token': '消耗',
  'API': '接口',
  'function call': '操作',
  'tool call': '操作',
  'context window': '记忆空间',
  'system prompt': '规则',
  'cache': '缓存',
  'RAG': '记忆检索',
}

const TRANSLATION_PATTERNS = [
  '已成功', '将会', '基于', '此外', '综上所述',
  '具体来说', '接下来我将', '以下是', '请注意',
]

export interface StyleIssue {
  type: 'markdown' | 'tech_term' | 'translation' | 'too_long'
  detail: string
  fixed: boolean
}

export function guardStyle(text: string): { cleaned: string; issues: StyleIssue[] } {
  let cleaned = text
  const issues: StyleIssue[] = []

  for (const pattern of MARKDOWN_PATTERNS) {
    const matches = cleaned.match(pattern)
    if (matches) {
      for (const m of matches) {
        issues.push({ type: 'markdown', detail: m.slice(0, 30), fixed: true })
      }
    }
  }
  cleaned = cleaned.replace(/^#{1,6}\s+/gm, '')
  cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, '$1')
  // 不清单星号斜体：成对单星号常是算式/数量(香蕉*2、a*b*c)，删星号会破坏数字含义；
  // 中文聊天几乎不出现 markdown 斜体，误伤大于收益
  cleaned = cleaned.replace(/^[-*]\s+(?=[^\d\s])/gm, '')
  cleaned = cleaned.replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, '').trim())
  cleaned = cleaned.replace(/`([^`]+)`/g, '$1')

  for (const [term, replacement] of Object.entries(TECH_TERMS)) {
    const regex = new RegExp(`\\b${term}\\b`, 'gi')
    if (regex.test(cleaned)) {
      issues.push({ type: 'tech_term', detail: term, fixed: true })
      cleaned = cleaned.replace(regex, replacement)
    }
  }

  for (const phrase of TRANSLATION_PATTERNS) {
    if (cleaned.includes(phrase)) {
      issues.push({ type: 'translation', detail: phrase, fixed: false })
    }
  }

  if (cleaned.length > 500) {
    issues.push({ type: 'too_long', detail: `${cleaned.length}字`, fixed: false })
  }

  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim()

  return { cleaned, issues }
}
