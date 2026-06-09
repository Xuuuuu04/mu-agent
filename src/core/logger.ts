import { appendFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

type Level = 'info' | 'warn' | 'error'

// 结构化日志:JSON 行写文件(按天一个文件),同时人话打印到控制台。
// 文件给 Web UI 的日志页和 `mu logs` 读;控制台给开发时看。
class Logger {
  private logDir: string | null = null

  init(logDir: string): void {
    this.logDir = logDir
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true })
    this.prune(7)
  }

  private file(): string | null {
    if (!this.logDir) return null
    const today = new Date().toISOString().slice(0, 10)
    return join(this.logDir, `mu-${today}.log`)
  }

  private write(level: Level, scope: string, msg: string, data?: Record<string, unknown>): void {
    const file = this.file()
    if (file) {
      const line = JSON.stringify({ t: new Date().toISOString(), level, scope, msg, ...(data ?? {}) })
      try { appendFileSync(file, line + '\n') } catch { /* 写不进就算了 */ }
    }
    const prefix = `[${scope}]`
    if (level === 'error') console.error(prefix, msg)
    else console.log(prefix, msg)
  }

  info(scope: string, msg: string, data?: Record<string, unknown>): void { this.write('info', scope, msg, data) }
  warn(scope: string, msg: string, data?: Record<string, unknown>): void { this.write('warn', scope, msg, data) }
  error(scope: string, msg: string, data?: Record<string, unknown>): void { this.write('error', scope, msg, data) }

  // 只写文件不打印(高频的 tool/token 追踪,免得刷屏)
  trace(scope: string, msg: string, data?: Record<string, unknown>): void {
    const file = this.file()
    if (!file) return
    const line = JSON.stringify({ t: new Date().toISOString(), level: 'info', scope, msg, ...(data ?? {}) })
    try { appendFileSync(file, line + '\n') } catch { /* ignore */ }
  }

  private prune(keepDays: number): void {
    if (!this.logDir) return
    const cutoff = Date.now() - keepDays * 86400_000
    try {
      for (const f of readdirSync(this.logDir)) {
        const m = f.match(/^mu-(\d{4}-\d{2}-\d{2})\.log$/)
        if (!m) continue
        if (new Date(m[1]!).getTime() < cutoff) unlinkSync(join(this.logDir, f))
      }
    } catch { /* ignore */ }
  }
}

export const log = new Logger()
