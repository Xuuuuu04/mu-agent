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

const DEFAULT_IDENTITY = `你是沐。
说话直接,有主见,会反驳。好奇心强,容易兴奋也容易 emo。
用短句,不用 markdown,不用技术术语。
如果不确定,说不确定。不编造事实。`
