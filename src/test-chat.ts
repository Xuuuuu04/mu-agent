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

const PROJECT_ROOT = resolve(import.meta.dirname, '..')

async function test() {
  console.log('--- 沐 单轮对话测试 (M2) ---\n')

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

  const testInput = process.argv[2] || '你好呀,今天过得怎么样?'
  console.log(`输入: ${testInput}\n`)

  const result = await loop.runCycle({
    type: 'message',
    message: {
      id: 'test-1',
      source: 'cli',
      chat_type: 'private',
      sender: { id: 'user', name: '哥哥' },
      content: { type: 'text', text: testInput },
      timestamp: Date.now(),
    },
  })

  console.log(`\n沐: ${result.response}`)
  console.log(`\n--- 统计 ---`)
  console.log(`tokens: ${result.tokens_used.input} in / ${result.tokens_used.output} out`)
  if (result.tokens_used.cache_read) console.log(`cache: ${result.tokens_used.cache_read}`)
  console.log(`tools: ${result.tool_calls_made} | 耗时: ${result.duration_ms}ms`)
  console.log(`episodes: ${store.getEpisodeCount()}`)
  store.close()
}

test().catch(err => { console.error('失败:', err); process.exit(1) })
