import { watch } from 'chokidar'
import { readFileSync, readdirSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import type { ToolDef, ToolResult } from '../core/types.js'
import type { ToolRegistry } from './registry.js'
import { runPresetShell } from './builtin/shell.js'
import { ssrfBlocked } from './builtin/web.js'

// 命令注入载体:命令分隔/管道/后台/命令替换/重定向/子 shell/双引号闭合逃逸/换行/反斜杠。
// 不含空格和单引号——预置工具模板靠空格分词(phone 的"点坐标 x y"),单引号在双引号模板里是字面量、
// 裸模板里最多导致引号不配对(shell 报错而非注入),留给正常英文撇号(哥哥's)。
const DANGEROUS_PARAM = /[;&|$`()<>"\\\n\r]/

// 把参数值填进预置工具的命令模板。模板由 operator 写(自带引号/分词约定,如 ring_bell 的 "{{title}}"、
// phone 的裸 {{args}}),不能 shell 转义(会破坏这些语义)。改为:参数值含注入元字符就拒绝执行,
// 正常值(文字/数字/多词)原样替换。纯函数,便于对真实模板做 round-trip 测试。
export function substituteParams(
  template: string,
  params: Record<string, unknown>,
): { cmd: string } | { error: string } {
  let cmd = template
  for (const [key, val] of Object.entries(params)) {
    const s = String(val)
    if (DANGEROUS_PARAM.test(s)) {
      return { error: `参数「${key}」含 shell 元字符,拒绝执行(防注入): ${s.slice(0, 60)}` }
    }
    cmd = cmd.split(`{{${key}}}`).join(s)   // 全局替换:同名占位符出现多次都替
  }
  return { cmd }
}

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
        // 参数值可能来自抓取的网页等不可信来源:含注入元字符直接拒绝,不让它变 shell 语法执行。
        const r = substituteParams(def.command, params)
        if ('error' in r) return { success: false, output: '', error: r.error }
        return runPresetShell(r.cmd, 30_000)
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
