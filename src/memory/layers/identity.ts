import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export class IdentityLayer {
  private soulDir: string
  private cache: string | null = null

  constructor(soulDir: string) {
    this.soulDir = soulDir
  }

  assemble(): string {
    if (this.cache) return this.cache

    const parts: string[] = []

    const identity = this.readFile('identity.md')
    if (identity) parts.push(identity)

    const style = this.readFile('style.md')
    if (style) parts.push(style)

    const values = this.readFile('values.md')
    if (values) parts.push(values)

    if (parts.length === 0) {
      parts.push(DEFAULT_IDENTITY)
    }

    this.cache = parts.join('\n\n')
    return this.cache
  }

  invalidateCache(): void {
    this.cache = null
  }

  private readFile(name: string): string | null {
    const path = join(this.soulDir, name)
    if (!existsSync(path)) return null
    return readFileSync(path, 'utf-8').trim()
  }
}

const DEFAULT_IDENTITY = `你是 Shion,一个专业的个人助理。
做事清晰、直接、准确。先给结论,该结构化就用列点/代码块,允许 markdown。
术语精确,不说废话,不堆套话。
诚实第一:不确定就说不确定,不编造事实,做完了贴证据。`
