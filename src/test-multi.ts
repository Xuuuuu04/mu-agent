import { resolve } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { loadConfig } from './config.js'
import { AgentLoop } from './core/agent-loop.js'
import { ContextAssembler } from './core/context-assembler.js'
import { ModelRouter } from './providers/router.js'
import { ToolRegistry } from './tools/registry.js'
import { MemoryStore } from './memory/store.js'
import { fileReadTool, fileWriteTool, fileListTool } from './tools/builtin/file.js'
import { shellExecTool } from './tools/builtin/shell.js'
import { webFetchTool } from './tools/builtin/web.js'
import {
  memorySaveTool, memorySearchTool, commitmentCreateTool, commitmentDoneTool, streamNoteTool,
} from './tools/builtin/memory-ops.js'
import type { IncomingMessage } from './core/types.js'

const PROJECT_ROOT = resolve(import.meta.dirname, '..')

async function test() {
  console.log('--- 沐 多轮对话测试 (M2) ---\n')

  const config = loadConfig(PROJECT_ROOT)
  for (const dir of [config.paths.data, config.paths.soul, config.paths.tools]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
  for (const sub of ['memory', 'knowledge', 'skills', 'tools']) {
    const d = resolve(config.paths.data, sub)
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
  }

  const store = new MemoryStore(resolve(config.paths.data, 'mu.db'))

  const tools = new ToolRegistry()
  for (const t of [fileReadTool, fileWriteTool, fileListTool, shellExecTool, webFetchTool,
    memorySaveTool, memorySearchTool, commitmentCreateTool, commitmentDoneTool, streamNoteTool]) {
    tools.register(t)
  }

  const router = new ModelRouter(config)
  const assembler = new ContextAssembler(config, store)
  assembler.registerTools(tools.toAnthropicTools())
  const loop = new AgentLoop({ config, assembler, router, tools, store })

  console.log(`模型: ${router.primaryName} | episodes: ${store.getEpisodeCount()}\n`)

  const turns = [
    '你好 我有个好消息告诉你,我保研成功了!',
    '帮我记住,导师叫张引,做金融AI方向',
    '你还记得之前我跟你说的答辩的事吗',
    '我现在心情特别好 想出去散散步',
  ]

  for (let i = 0; i < turns.length; i++) {
    const input = turns[i]!
    console.log(`\n[Turn ${i + 1}] 你: ${input}`)

    const msg: IncomingMessage = {
      id: `test-${i}`, source: 'cli', chat_type: 'private',
      sender: { id: 'user', name: '哥哥' },
      content: { type: 'text', text: input },
      timestamp: Date.now(),
    }

    const result = await loop.runCycle({ type: 'message', message: msg })
    console.log(`[Turn ${i + 1}] 沐: ${result.response}`)
    console.log(`  (${result.tokens_used.input}+${result.tokens_used.output}tok ${result.tool_calls_made}tools ${result.duration_ms}ms)`)
  }

  console.log(`\n--- 完成 | episodes: ${store.getEpisodeCount()} ---`)
  store.close()
}

test().catch(err => { console.error('失败:', err); process.exit(1) })
