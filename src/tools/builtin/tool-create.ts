import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { ToolDef } from '../../core/types.js'

export const toolCreateTool: ToolDef = {
  name: 'tool_create',
  description: '创建一个新工具。写一个 JSON 工具定义,系统会自动加载它。支持两种类型:shell 命令工具(需要 command 字段)和 HTTP API 工具(需要 url 字段)。参数用 {{参数名}} 占位。',
  parameters: {
    name: { type: 'string', description: '工具名称(英文小写+连字符)' },
    description: { type: 'string', description: '工具功能描述' },
    tool_type: { type: 'string', description: 'shell 或 http' },
    command_or_url: { type: 'string', description: 'shell 命令模板 或 HTTP URL 模板,参数用 {{name}} 占位' },
    parameters: { type: 'object', description: '参数定义,JSON 对象,每个 key 是参数名,value 是 {type, description}' },
    http_method: { type: 'string', description: 'HTTP 方法(GET/POST),仅 http 类型需要', required: false as unknown as string },
  },
  async execute(params, ctx) {
    const name = params.name as string
    // name 直接拼进文件路径，必须严格校验，否则 '../x' 能写到 toolsDir 之外
    if (!/^[a-z][a-z0-9-]{0,40}$/.test(name)) {
      return { success: false, output: '', error: '工具名只能是小写字母开头、由 a-z 0-9 - 组成(≤41 字符)' }
    }
    const toolsDir = join(ctx.dataDir, 'tools')
    if (!existsSync(toolsDir)) mkdirSync(toolsDir, { recursive: true })

    const filePath = join(toolsDir, `${name}.json`)
    if (existsSync(filePath)) {
      return { success: false, output: '', error: `工具 ${name} 已存在,请用其他名字` }
    }

    const toolType = params.tool_type as string
    const definition: Record<string, unknown> = {
      name,
      description: params.description as string,
      parameters: params.parameters as Record<string, unknown>,
    }

    if (toolType === 'shell') {
      definition.command = params.command_or_url as string
    } else if (toolType === 'http') {
      definition.url = params.command_or_url as string
      definition.method = (params.http_method as string) || 'GET'
    } else {
      return { success: false, output: '', error: `未知类型: ${toolType},请用 shell 或 http` }
    }

    writeFileSync(filePath, JSON.stringify(definition, null, 2), 'utf-8')
    ctx.log(`创建了工具: ${name} (${toolType})`)
    return { success: true, output: `工具 ${name} 创建成功,已写入 ${filePath},会自动加载` }
  },
}
