// 记忆类工具的共享小工具:目录确保、关键词模糊匹配、token 抽取。
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type ToolResult = { success: boolean; output: string; error?: string }

export function ensureDir(filePath: string): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

// 关键词模糊匹配:整句对不上时,提取关键 token(航班号/中文词)找匹配最多的行
export function fuzzyMatchLine(lines: string[], oldKey: string): number {
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

export function extractKeyTokens(text: string): string[] {
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
