// 模型回复里的内联指令解析与清洗。全是纯函数,容错正则是事故换来的,
// characterization test(core/agent-loop.test.ts)锁住它们的容错行为。

// [MOOD:情绪:原因] → { mood, reason }。reason 段挡住 ] 防贪婪吞过下个指令
export function extractMood(text: string): { mood: string; reason: string } | null {
  const m = text.match(/\[MOOD:([^:\]\n]+):?([^\]\n]*)\]?/)
  if (!m) return null
  return { mood: m[1]!.trim(), reason: (m[2] ?? '').trim() }
}

// [WAKE:秒数:原因:活动] → 下次唤醒。reason 段必须挡住 ]:她写 [WAKE:300:催饭/active]
// (用/合并漏了一段)时,旧正则 [^:]* 会贪婪吞过 ] 一路吃到下一个 [MOOD 的冒号。
// activity 段可选——缺了按 rest 算,别让整条指令作废
export function extractWakeDirective(text: string): { seconds: number; reason: string; activity_type: string } | null {
  const match = text.match(/\[WAKE:(\d+):([^:\]\n]*)(?::([^\]\n]*))?\]?/)
  if (!match) return null
  return {
    seconds: parseInt(match[1]!),
    reason: match[2]!.trim(),
    activity_type: (match[3] ?? '').trim() || 'rest',
  }
}

// 从回复里抽意识流条目。长度判断必须在清洗之后:纯 [WAKE][MOOD] 指令的回复清洗完是空的,
// 旧逻辑在清洗前判长度,导致意识流里出现空白条目
export function extractStreamEntry(text: string): { content: string; activity?: string } | null {
  if (!text) return null
  const clean = text
    .replace(/\[WAKE:[^\]\n]*\]?/g, '')
    .replace(/\[MOOD:[^\]\n]*\]?/g, '')
    .replace(/\n+/g, ' ')
    .trim()
  if (clean.length < 5) return null
  return { content: truncateAtBoundary(clean, 200), activity: 'chat' }
}

// 把内部指令标记从给用户看的文本里抹掉
export function cleanResponse(text: string): string {
  return text
    .replace(/\[WAKE:[^\]\n]*\]?/g, '')
    .replace(/\[MOOD:[^\]\n]*\]?/g, '')
    .trim()
}

// 意识流截断:超长时尽量在标点/空格处断,别把一句话腰斩("也可能已"这种)
export function truncateAtBoundary(text: string, max: number): string {
  if (text.length <= max) return text
  const slice = text.slice(0, max)
  const boundary = Math.max(
    slice.lastIndexOf(' '),
    ...['。', '!', '?', '!', '?', ',', ',', ' ', '…'].map(p => slice.lastIndexOf(p)),
  )
  return boundary > max * 0.6 ? slice.slice(0, boundary + 1).trim() : slice
}
