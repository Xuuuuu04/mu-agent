import { execSync } from 'node:child_process'
import { basename } from 'node:path'
import type { ToolDef, ToolResult } from '../../core/types.js'

// 预置工具(data/tools/*.json)的静态拒绝规则。deny-list 本质拦不全(变量间接、编码绕过都能过),
// 不是安全边界——真正的边界是 hot-reload 对参数值的元字符校验(含则拒执行,堵注入面)+ tool-create 创建期这张表的预检。
// 这里只做纵深防御,尽量拦住最灾难的几类。大小写不敏感(Linux 命令名虽区分大小写,但保守)。
export const BLOCKED_PATTERNS = [
  /rm\s+-[a-z]*[rf]/i,              // rm -rf / rm -r / rm -f(不止 rm -rf /)
  /mkfs/i,
  /dd\s+if=/i,
  /shutdown/i,
  /reboot/i,
  /\bkill\s+-9\s+1\b/,
  />\s*\/dev\/(sd|nvme|disk)/i,
  /chmod\s+-R\s+777/i,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,   // fork bomb
  /\|\s*(sh|bash|zsh)\b/i,          // 任意管道到 shell(curl|sh / base64 -d|sh 都覆盖)
  /\bbase64\s+-+d\b/i,              // base64 解码(常配合 |sh 绕过明文匹配)
]

// 命中任一灾难规则?tool-create 创建期和 runPresetShell 执行期共用,避免规则两处漂移。
export function isBlockedShellCommand(command: string): boolean {
  return BLOCKED_PATTERNS.some(p => p.test(command))
}

interface PendingShell {
  command: string
  timeoutMs: number
  expiresAt: number
}

const pending = new Map<string, PendingShell>()
const APPROVAL_TTL_MS = 10 * 60_000

export const shellExecTool: ToolDef = {
  name: 'shell_exec',
  description: '执行机器诊断命令。只读命令直接执行；写文件、重启、删除、联网脚本等有副作用命令会生成一次性批准号，必须由用户亲自发送 /approve-shell <id> 才执行',
  parameters: {
    command: { type: 'string', description: '要执行的命令' },
    timeout: { type: 'number', description: '超时秒数,默认30,最大120', required: false as unknown as string },
  },
  async execute(params) {
    const command = String(params.command ?? '').trim()
    if (!command) return { success: false, output: '', error: '命令为空' }
    const timeoutMs = Math.min(120, Math.max(1, Number(params.timeout) || 30)) * 1000
    return requestShellExecution(command, timeoutMs)
  },
}

// 模型自造的 shell（shell_exec）走这里：写副作用命令一律要真人批准，模型无法靠换工具绕过。
export function requestShellExecution(command: string, timeoutMs = 30_000): ToolResult {
  cleanupExpired()
  if (isSafeReadOnlyCommand(command)) return runShell(command, timeoutMs)
  const id = `sh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  pending.set(id, { command, timeoutMs, expiresAt: Date.now() + APPROVAL_TTL_MS })
  return {
    success: false,
    output: '',
    error: `命令有副作用，尚未执行。请用户亲自发送 /approve-shell ${id} 批准；10分钟后过期。待执行: ${command.slice(0, 300)}`,
  }
}

// operator 投喂的预置工具（data/tools/*.json，如 ring_bell/phone）走这里：是受信任工具不是模型自造 shell，
// 直接执行以保留自主性（自决唤醒/proactive 是内心独白，批准号无人接收）。只保留 BLOCKED_PATTERNS 拦灾难命令。
export function runPresetShell(command: string, timeoutMs = 30_000): ToolResult {
  if (isBlockedShellCommand(command)) return { success: false, output: '', error: `危险命令被阻止: ${command}` }
  return runShell(command, timeoutMs)
}

// 只从零 token 的用户命令拦截器调用；LLM 工具 schema 不暴露这个函数。
export function approveShellRequest(id: string): string {
  cleanupExpired()
  const item = pending.get(id)
  if (!item) return `Shell 批准号 ${id} 不存在或已过期`
  pending.delete(id) // 一次性，执行失败也不能重放
  const result = runShell(item.command, item.timeoutMs)
  if (result.success) {
    return `已执行 Shell 命令:\n${item.command}\n\n${result.output || '(无输出)'}`
  }
  return `Shell 命令执行失败:\n${item.command}\n${result.error}\n${result.output}`
}

export function rejectShellRequest(id: string): string {
  cleanupExpired()
  if (!pending.delete(id)) return `Shell 批准号 ${id} 不存在或已过期`
  return `已拒绝 Shell 命令 ${id}`
}

function cleanupExpired(): void {
  const now = Date.now()
  for (const [id, item] of pending) {
    if (item.expiresAt <= now) pending.delete(id)
  }
}

function isSafeReadOnlyCommand(command: string): boolean {
  // 不尝试“理解 shell”；出现组合/重定向/展开能力就一律要求真人批准。
  if (/[;&|><`$\\\n]/.test(command)) return false
  const words = command.trim().split(/\s+/)
  const exe = basename(words[0] ?? '')
  const args = words.slice(1)
  const alwaysReadOnly = new Set([
    'pwd', 'ls', 'df', 'du', 'free', 'uptime', 'ps', 'pgrep', 'nvidia-smi',
    'stat', 'whoami', 'date', 'uname',
  ])
  if (alwaysReadOnly.has(exe)) return true
  if (exe === 'git') return ['status', 'diff', 'log', 'show', 'branch', 'rev-parse'].includes(args[0] ?? '')
  if (exe === 'pm2') return ['list', 'status', 'logs', 'show', 'describe', 'monit'].includes(args[0] ?? '')
  if (exe === 'systemctl') return ['status', 'is-active', 'is-enabled', 'show'].includes(args[0] ?? '')
  if (exe === 'journalctl') return true
  return false
}

function runShell(command: string, timeoutMs: number): ToolResult {
  try {
    const output = execSync(command, {
      timeout: timeoutMs,
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
}
