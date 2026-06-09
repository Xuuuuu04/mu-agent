import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'

interface Skill {
  name: string
  trigger: string[]
  tools?: string[]
  body: string
}

// L5 技能记忆。data/skills/*.md,带 frontmatter(name/trigger/tools)。
// 输入命中 trigger 关键词时,把这个 skill 的步骤注入 context,告诉 agent "这事这么做"。
export class ProceduralLayer {
  private skillsDir: string
  private cache: Skill[] | null = null
  private cacheTime = 0

  constructor(dataDir: string) {
    this.skillsDir = join(dataDir, 'skills')
  }

  assemble(currentInput?: string): string {
    if (!currentInput) return ''
    const skills = this.loadSkills()
    if (skills.length === 0) return ''

    const matched = skills.filter(s =>
      s.trigger.some(t => currentInput.includes(t))
    )
    if (matched.length === 0) return ''

    const parts: string[] = ['--- 相关技能(你之前总结的做法) ---']
    for (const s of matched.slice(0, 2)) {
      parts.push(`【${s.name}】`)
      parts.push(s.body.trim())
    }
    return parts.join('\n')
  }

  private loadSkills(): Skill[] {
    // 30 秒缓存,避免每次推理都扫盘
    if (this.cache && Date.now() - this.cacheTime < 30000) return this.cache
    if (!existsSync(this.skillsDir)) { this.cache = []; return [] }

    const skills: Skill[] = []
    for (const file of readdirSync(this.skillsDir)) {
      if (!file.endsWith('.md')) continue
      try {
        const raw = readFileSync(join(this.skillsDir, file), 'utf-8')
        const skill = this.parse(raw, file.replace(/\.md$/, ''))
        if (skill) skills.push(skill)
      } catch { /* 坏文件跳过 */ }
    }

    this.cache = skills
    this.cacheTime = Date.now()
    return skills
  }

  private parse(raw: string, fallbackName: string): Skill | null {
    const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    if (!m) {
      // 没 frontmatter 的当纯知识,不作技能
      return null
    }
    try {
      const meta = YAML.parse(m[1]!) as { name?: string; trigger?: string[]; tools?: string[] }
      const trigger = Array.isArray(meta.trigger) ? meta.trigger : []
      if (trigger.length === 0) return null
      return {
        name: meta.name || fallbackName,
        trigger,
        tools: meta.tools,
        body: m[2]!,
      }
    } catch {
      return null
    }
  }

  list(): string[] {
    return this.loadSkills().map(s => s.name)
  }

  invalidate(): void {
    this.cache = null
  }
}
