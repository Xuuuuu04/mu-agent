// 发给用户 / 入库前的轻量清理。
// 专业助理允许 markdown 和精确术语,所以这里不再删 markdown、不翻译术语——
// 只做空白规整(折叠多余空行 + 首尾 trim)。保留 {cleaned, issues} 签名给调用方。

export interface StyleIssue {
  type: string
  detail: string
  fixed: boolean
}

export function guardStyle(text: string): { cleaned: string; issues: StyleIssue[] } {
  const cleaned = text.replace(/\n{3,}/g, '\n\n').trim()
  return { cleaned, issues: [] }
}
