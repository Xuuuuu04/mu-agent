import type { ToolDef, AnthropicTool, ToolContext, ToolResult } from '../core/types.js'

// 子代理永久黑名单:即使 subsetFor 的 allowedNames 传了也物理剔除。
// 递归闸(spawn_*)+ 防乱发/劫持闹钟(message_send/voice_send/schedule_wake)。
// 白名单优于黑名单 filter:将来新增危险工具默认不进子代理,子代理 LLM 根本看不到这些定义。
export const SUBAGENT_TOOL_DENY = ['spawn_subagent', 'spawn_parallel', 'message_send', 'voice_send', 'schedule_wake']

export type ToolResolution =
  | { status: 'found'; query: string; suffix: string; name: string; tool: ToolDef }
  | { status: 'not_found'; query: string; suffix: string; matches: [] }
  | { status: 'ambiguous'; query: string; suffix: string; matches: string[] }

export class ToolRegistry {
  private tools = new Map<string, ToolDef>()
  private reserved = new Set<string>()

  register(tool: ToolDef, opts: { reserved?: boolean } = {}): void {
    if (opts.reserved) {
      this.reserved.add(tool.name)
    } else if (this.reserved.has(tool.name)) {
      // 动态/MCP 工具不能顶替内置高权限工具(否则 tool_create 造个同名 file_read 就能换掉沙箱实现)
      console.warn(`[registry] 拒绝注册 ${tool.name}：与内置工具同名`)
      return
    } else if (this.tools.has(tool.name)) {
      console.warn(`[registry] 工具 ${tool.name} 被同名覆盖`)
    }
    this.tools.set(tool.name, tool)
  }

  unregister(name: string): void {
    this.tools.delete(name)
  }

  isReserved(name: string): boolean {
    return this.reserved.has(name)
  }

  get(name: string): ToolDef | undefined {
    const exact = this.tools.get(name)
    if (exact) return exact
    // 自动兼容只用于带 MCP namespace 的名字,避免 file_read 等内置名被同后缀 MCP 工具接管。
    if (!name.includes('__')) return undefined
    const resolved = this.resolveBySuffix(name)
    return resolved.status === 'found' ? resolved.tool : undefined
  }

  // MCP server 名可能随部署配置改变前缀。精确名不存在时,只允许按 `__` 后的工具名
  // 唯一解析；零匹配/多匹配返回结构化结果,绝不猜一个继续执行。
  resolveBySuffix(query: string): ToolResolution {
    const marker = query.lastIndexOf('__')
    const suffix = marker >= 0 ? query.slice(marker + 2) : query
    const matches = Array.from(this.tools.keys())
      .filter(name => name === suffix || name.endsWith(`__${suffix}`))
      .sort()
    if (matches.length === 0) return { status: 'not_found', query, suffix, matches: [] }
    if (matches.length > 1) return { status: 'ambiguous', query, suffix, matches }
    const name = matches[0]!
    return { status: 'found', query, suffix, name, tool: this.tools.get(name)! }
  }

  async execute(name: string, params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) {
      return { success: false, output: '', error: `unknown tool: ${name}` }
    }

    try {
      return await tool.execute(params, ctx)
    } catch (err) {
      return {
        success: false,
        output: '',
        error: `tool ${name} threw: ${(err as Error).message}`,
      }
    }
  }

  toAnthropicTools(): AnthropicTool[] {
    return Array.from(this.tools.values()).map(t => ({
      name: t.name,
      description: t.description,
      input_schema: {
        type: 'object',
        properties: stripInternalRequired(t.parameters),
        required: t.requiredKeys ?? Object.entries(t.parameters)
          .filter(([, v]) => (v as Record<string, unknown>).required !== false)
          .map(([k]) => k),
      },
    }))
  }

  // 子代理工具子集:白名单交集,且永久剔除 SUBAGENT_TOOL_DENY(传了也不给)。
  // 子代理 LLM 只看得到这里返回的定义,物理上发不出 spawn_*/message_send 等 tool_use。
  subsetFor(allowedNames: string[]): AnthropicTool[] {
    const deny = new Set(SUBAGENT_TOOL_DENY)
    const allow = new Set(allowedNames.filter(n => !deny.has(n)))
    return this.toAnthropicTools().filter(t => allow.has(t.name))
  }

  areParallelSafe(names: string[]): boolean {
    return names.length > 0 && names.every(name => this.tools.get(name)?.parallelSafe === true)
  }

  get size(): number {
    return this.tools.size
  }

  list(): string[] {
    return Array.from(this.tools.keys())
  }
}

// ToolDef 用属性里的 `required:false` 表达内部可选性;它不是 JSON Schema
// property keyword。对外 schema 只保留顶层 required 数组,避免严格 provider 拒绝整个 tools 参数。
function stripInternalRequired(parameters: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(parameters).map(([name, value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [name, value]
    const schema = { ...value as Record<string, unknown> }
    delete schema.required
    return [name, schema]
  }))
}
