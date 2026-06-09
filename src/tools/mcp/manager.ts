import { McpClient, type McpServerConfig } from './client.js'
import type { ToolRegistry } from '../registry.js'

// 管理多个 MCP server:启动时连接、注册其工具,关闭时统一断开。
export class McpManager {
  private clients: McpClient[] = []

  async loadAll(servers: McpServerConfig[], registry: ToolRegistry): Promise<number> {
    // 并行连接,单个失败/超时不拖累其它
    const results = await Promise.allSettled(servers.map(async (s) => {
      const client = new McpClient(s)
      const tools = await client.connect()
      for (const t of tools) registry.register(t)
      this.clients.push(client)
      console.log(`[mcp] ${s.name}: ${tools.length} 个工具`)
      return tools.length
    }))

    let total = 0
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') total += r.value
      else console.error(`[mcp] ${servers[i]?.name} 连接失败: ${(r.reason as Error).message}`)
    })
    return total
  }

  stopAll(): void {
    for (const c of this.clients) c.disconnect()
    this.clients = []
  }
}
