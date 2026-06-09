import type { ToolDef, AnthropicTool, ToolContext, ToolResult } from '../core/types.js'

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

  get size(): number {
    return this.tools.size
  }

  list(): string[] {
    return Array.from(this.tools.keys())
  }
}
