import type { ToolDef, AnthropicTool, ToolContext, ToolResult } from '../core/types.js'

// 子代理永久黑名单:即使 subsetFor 的 allowedNames 传了也物理剔除。
// 递归闸(spawn_*)+ 防乱发/劫持闹钟(message_send/voice_send/schedule_wake)。
// 白名单优于黑名单 filter:将来新增危险工具默认不进子代理,子代理 LLM 根本看不到这些定义。
export const SUBAGENT_TOOL_DENY = ['spawn_subagent', 'spawn_parallel', 'message_send', 'voice_send', 'schedule_wake']

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

  get(name: string): ToolDef | undefined {
    return this.tools.get(name)
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
        properties: t.parameters,
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

  get size(): number {
    return this.tools.size
  }

  list(): string[] {
    return Array.from(this.tools.keys())
  }
}
