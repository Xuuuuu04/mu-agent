import { watch } from 'chokidar'
import { readFileSync, readdirSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import type { ToolDef, ToolContext, ToolResult } from '../core/types.js'
import type { ToolRegistry } from './registry.js'
import { BLOCKED_PATTERNS } from './builtin/shell.js'
import { ssrfBlocked } from './builtin/web.js'

export class HotReloader {
  private toolsDir: string
  private registry: ToolRegistry
  private watcher: ReturnType<typeof watch> | null = null

  constructor(toolsDir: string, registry: ToolRegistry) {
    this.toolsDir = toolsDir
    this.registry = registry
    if (!existsSync(toolsDir)) mkdirSync(toolsDir, { recursive: true })
  }

  start(): void {
    this.loadExisting()

    this.watcher = watch(this.toolsDir, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500 },
    })

    this.watcher.on('add', (path) => this.handleFile(path, 'add'))
    this.watcher.on('change', (path) => this.handleFile(path, 'change'))
    this.watcher.on('unlink', (path) => this.handleFile(path, 'remove'))

    console.log(`[hot-reload] 监视 ${this.toolsDir}`)
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
  }

  private loadExisting(): void {
    if (!existsSync(this.toolsDir)) return
    const files = readdirSync(this.toolsDir).filter((f: string) => f.endsWith('.json'))

    for (const file of files) {
      const path = join(this.toolsDir, file)
      this.handleFile(path, 'add')
    }
  }

  private handleFile(path: string, event: 'add' | 'change' | 'remove'): void {
    const ext = extname(path)
    if (ext !== '.json') return
    const name = basename(path, ext)

    if (event === 'remove') {
      if (this.registry.get(name)) {
        this.registry.unregister(name)
        console.log(`[hot-reload] 移除工具: ${name}`)
      }
      return
    }

    try {
      const raw = readFileSync(path, 'utf-8')
      const def = JSON.parse(raw) as {
        name: string
        description: string
        parameters: Record<string, unknown>
        command?: string
        url?: string
        method?: string
      }

      const tool = this.buildTool(def)
      this.registry.register(tool)
      console.log(`[hot-reload] ${event === 'add' ? '加载' : '更新'}工具: ${tool.name}`)
    } catch (err) {
      console.error(`[hot-reload] 工具 ${name} 加载失败: ${(err as Error).message}`)
      this.quarantine(path, (err as Error).message)
    }
  }

  private buildTool(def: {
    name: string
    description: string
    parameters: Record<string, unknown>
    command?: string
    url?: string
    method?: string
  }): ToolDef {
    if (def.command) {
      return this.buildShellTool(def as typeof def & { command: string })
    }
    if (def.url) {
      return this.buildHttpTool(def as typeof def & { url: string })
    }
    throw new Error('工具定义需要 command 或 url 字段')
  }

  private buildShellTool(def: { name: string; description: string; parameters: Record<string, unknown>; command: string }): ToolDef {
    return {
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      async execute(params: Record<string, unknown>): Promise<ToolResult> {
        const { execSync } = await import('node:child_process')
        let cmd = def.command
        for (const [key, val] of Object.entries(params)) {
          cmd = cmd.split(`{{${key}}}`).join(String(val))   // 全局替换：同名占位符出现多次都替
        }
        for (const pattern of BLOCKED_PATTERNS) {
          if (pattern.test(cmd)) return { success: false, output: '', error: `危险命令被阻止: ${cmd}` }
        }
        try {
          const output = execSync(cmd, { encoding: 'utf-8', timeout: 30000, maxBuffer: 1024 * 1024 })
          return { success: true, output: output.slice(0, 10000) }
        } catch (err) {
          return { success: false, output: '', error: (err as Error).message.slice(0, 500) }
        }
      },
    }
  }

  private buildHttpTool(def: { name: string; description: string; parameters: Record<string, unknown>; url: string; method?: string }): ToolDef {
    return {
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      async execute(params: Record<string, unknown>): Promise<ToolResult> {
        let url = def.url
        for (const [key, val] of Object.entries(params)) {
          url = url.split(`{{${key}}}`).join(encodeURIComponent(String(val)))
        }
        const blocked = ssrfBlocked(url)
        if (blocked) return { success: false, output: '', error: blocked }
        try {
          const resp = await fetch(url, {
            method: def.method || 'GET',
            headers: { 'User-Agent': 'Mu-Agent/0.2' },
          })
          const text = await resp.text()
          return { success: resp.ok, output: text.slice(0, 10000), error: resp.ok ? undefined : `HTTP ${resp.status}` }
        } catch (err) {
          return { success: false, output: '', error: (err as Error).message }
        }
      },
    }
  }

  private quarantine(path: string, reason: string): void {
    const quarantineDir = join(this.toolsDir, '.quarantine')
    if (!existsSync(quarantineDir)) mkdirSync(quarantineDir, { recursive: true })
    const name = basename(path)
    try {
      renameSync(path, join(quarantineDir, name))
      writeFileSync(join(quarantineDir, `${name}.error.txt`), `${new Date().toISOString()}\n${reason}`, 'utf-8')
    } catch { /* ignore */ }
  }
}
