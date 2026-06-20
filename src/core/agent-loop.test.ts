import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentLoop } from './agent-loop.js'
import { ToolRegistry } from '../tools/registry.js'
import type { MuConfig, WakeTrigger, ContentBlock, ToolDef } from './types.js'
import type { ChatResponse } from '../providers/base.js'

// runCycle 集成测试:mock router/assembler,验证完整 cycle 流(含死亡螺旋相关的末轮回退)。
// 专业助理被动响应:不自动安排唤醒,也不解析 [WAKE]/[MOOD] 指令。

function minimalConfig(dataDir: string): MuConfig {
  return {
    model: { primary: { name: 'fake', format: 'openai', base_url: '', api_key: '', model: 'm', max_tokens: 4096 } },
    scheduler: { min_wake_seconds: 120, max_wake_seconds: 3600, max_sleep_seconds: 28800, cron_fallback_seconds: 900, night_min_wake_seconds: 1800, night_start_hour: 23, night_end_hour: 7 },
    agent: { max_turns_per_cycle: 10, session_timeout_minutes: 30 },
    paths: { soul: dataDir, data: dataDir, tools: join(dataDir, 'tools') },
  }
}

function res(content: ContentBlock[]): ChatResponse {
  return { id: 'r', content, stop_reason: 'end', usage: { input_tokens: 5, output_tokens: 3 } }
}
const textRes = (t: string) => res([{ type: 'text', text: t }])

// 脚本化 router:按队列依次返回,记录调用次数
function scriptedRouter(responses: ChatResponse[]) {
  let i = 0
  let calls = 0
  return {
    primaryName: 'fake',
    get calls() { return calls },
    chat: async () => { calls++; return responses[Math.min(i++, responses.length - 1)]! },
  }
}

// 记录 scheduleNext 的假 scheduler
function fakeScheduler() {
  const scheduled: Array<{ seconds: number; reason: string; activity_type: string }> = []
  return {
    scheduled,
    scheduleNext: (x: { seconds: number; reason: string; activity_type: string }) => { scheduled.push(x) },
    getStatus: () => ({ sleeping: false, nextWake: null, reason: '' }),
  }
}

const fakeAssembler = () => ({
  assemble: async () => ({ system: [{ type: 'text', text: 'sys' }] as ContentBlock[] }),
  setLastUserContact() {},
  setLastWake() {},
  streamLayer: { append() {} },
})

function setup(responses: ChatResponse[], opts: { tool?: ToolDef; withStore?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mu-al-'))
  mkdirSync(join(dir, 'memory'), { recursive: true })
  const router = scriptedRouter(responses)
  const scheduler = fakeScheduler()
  const tools = new ToolRegistry()
  if (opts.tool) tools.register(opts.tool, { reserved: true })
  const loop = new AgentLoop({
    config: minimalConfig(dir),
    assembler: fakeAssembler() as never,
    router: router as never,
    tools,
    scheduler: scheduler as never,
  })
  return { loop, router, scheduler, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const userMsg = (text: string): WakeTrigger => ({
  type: 'message',
  message: { id: 'm1', source: 'webhook', chat_type: 'private', sender: { id: 'bro', name: 'x' }, content: { type: 'text', text }, timestamp: 0 },
})

const tick = () => new Promise<void>(r => setTimeout(r, 40))

test('简单文本 cycle:无工具,回复=模型文本', async () => {
  const s = setup([textRes('在的呀')])
  try {
    const r = await s.loop.runCycle(userMsg('在吗'))
    assert.equal(r.response, '在的呀')
    assert.equal(r.tool_calls_made, 0)
  } finally { s.cleanup() }
})

test('工具循环:tool_use 轮 → 执行 → 文本轮收尾', async () => {
  let executed = 0
  const echo: ToolDef = {
    name: 'echo', description: 'e', parameters: {},
    execute: async () => { executed++; return { success: true, output: 'ok' } },
  }
  const s = setup([
    res([{ type: 'tool_use', id: 't1', name: 'echo', input: {} }]),
    textRes('查到了'),
  ], { tool: echo })
  try {
    const r = await s.loop.runCycle(userMsg('查一下'))
    assert.equal(executed, 1)
    assert.equal(r.tool_calls_made, 1)
    assert.equal(r.response, '查到了')
  } finally { s.cleanup() }
})

test('末轮纯指令回退:正文不蒸发(06-10 已读不回根因)', async () => {
  const echo: ToolDef = { name: 'echo', description: 'e', parameters: {}, execute: async () => ({ success: true, output: 'ok' }) }
  const s = setup([
    res([{ type: 'text', text: '去机场坐大巴' }, { type: 'tool_use', id: 't1', name: 'echo', input: {} }]),
    textRes('[WAKE:300:歇会:rest]'),   // 末轮只有指令
  ], { tool: echo })
  try {
    const r = await s.loop.runCycle(userMsg('怎么去'))
    // 正文回退到上一轮实质内容,指令被清掉
    assert.equal(r.response, '去机场坐大巴')
  } finally { s.cleanup() }
})

test('命令拦截:/help 零 token、不调 router', async () => {
  // 命令路径需要 store+scheduler;用 :memory: store
  const { MemoryStore } = await import('../memory/store.js')
  const dir = mkdtempSync(join(tmpdir(), 'mu-al-'))
  mkdirSync(join(dir, 'memory'), { recursive: true })
  const router = scriptedRouter([textRes('不该被调用')])
  const tools = new ToolRegistry()
  const loop = new AgentLoop({
    config: minimalConfig(dir), assembler: fakeAssembler() as never, router: router as never,
    tools, scheduler: fakeScheduler() as never, store: new MemoryStore(':memory:'),
  })
  try {
    const r = await loop.runCycle(userMsg('/help'))
    assert.equal(r.tokens_used.input, 0)
    assert.equal(r.tool_calls_made, 0)
    assert.equal(router.calls, 0, 'router 未被调用')
    assert.ok(r.response.length > 0, '有帮助文本')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('postProcess:回复无 [WAKE] → 不自动安排唤醒(被动响应)', async () => {
  const s = setup([textRes('就随便聊聊')])
  try {
    await s.loop.runCycle(userMsg('嗨'))
    await tick()   // postProcess 是 fire-and-forget,等它跑完
    assert.equal(s.scheduler.scheduled.length, 0, '不再补默认唤醒')
  } finally { s.cleanup() }
})

test('postProcess:回复带 [WAKE:600] → 指令清掉但不据此调度', async () => {
  const s = setup([textRes('困了[WAKE:600:消化:rest]')])
  try {
    const r = await s.loop.runCycle(userMsg('晚安'))
    assert.equal(r.response, '困了')   // 指令仍从回复里清掉(cleanResponse)
    await tick()
    assert.ok(!s.scheduler.scheduled.some(x => x.seconds === 600), '不再按 [WAKE] 自动调度')
  } finally { s.cleanup() }
})
