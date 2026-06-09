import { execSync } from 'node:child_process'
import type { ToolDef } from '../../core/types.js'

export const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\//,
  /mkfs/,
  /dd\s+if=\/dev/,
  /shutdown/,
  /reboot/,
  /kill\s+-9\s+1\b/,
  />\s*\/dev\/sd/,
  /chmod\s+-R\s+777\s+\//,
  /:(){ :\|:& };:/,
]

export const shellExecTool: ToolDef = {
  name: 'shell_exec',
  description: '执行 shell 命令并返回输出',
  parameters: {
    command: { type: 'string', description: '要执行的命令' },
    timeout: { type: 'number', description: '超时秒数,默认30', required: false as unknown as string },
  },
  async execute(params) {
    const command = params.command as string
    const timeout = ((params.timeout as number) || 30) * 1000

    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(command)) {
        return { success: false, output: '', error: `危险命令被阻止: ${command}` }
      }
    }

    try {
      const output = execSync(command, {
        timeout,
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const trimmed = output.length > 10000
        ? output.slice(0, 10000) + '\n...(输出截断)'
        : output
      return { success: true, output: trimmed }
    } catch (err) {
      const e = err as { stderr?: string; message: string; status?: number }
      return {
        success: false,
        output: e.stderr || '',
        error: `exit ${e.status ?? 'unknown'}: ${e.message.slice(0, 500)}`,
      }
    }
  },
}
