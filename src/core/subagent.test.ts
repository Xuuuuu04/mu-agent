import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ToolRegistry } from '../tools/registry.js'
import type { ChatParams, ChatResponse } from '../providers/base.js'
import type { ModelRouter } from '../providers/router.js'
import type { ChatMessage, ContentBlock, MuConfig, ToolContext, ToolDef } from './types.js'
import {
  runSubagent, runSubagentsParallel, buildSubagentRouter, SUBAGENT_MAX_TOKENS,
  MAX_SUBAGENT_DEPTH, MAX_SUBAGENT_CONCURRENT, MAX_SUBAGENTS_PER_TASK, SUBAGENT_INPUT_BUDGET,
  resetSubagentTaskBudget as resetBudget, getActiveSubagents,
} from './subagent.js'
import {
  spawnSubagentTool, spawnParallelTool, bindRegistry, resetSubagentTaskBudget,
} from '../tools/builtin/spawn-subagent.js'
import { runToolLoop } from './loop/tool-loop.js'

// ── mock router:不打网络,按脚本返固定 blocks。记录每次 chat 的入参(验隔离/系统提示)──
function mockRouter(opts: {
  reply?: ContentBlock[]            // 单轮回复(默认一段纯文本)
  throwOnChat?: boolean             // 模拟 chat 挂掉(验 fail-open)
  capture?: ChatParams[]            // 记录每次 chat 入参
}): ModelRouter {
  const reply = opts.reply ?? [{ type: 'text', text: '子代理结论:已查到答案 X' }]
  const chat = async (params: ChatParams): Promise<ChatResponse> => {
    opts.capture?.push(params)
    if (opts.throwOnChat) throw new Error('mock router 挂了')
    return {
      id: 'mock',
      content: reply,
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    }
  }
  return { chat, primaryName: 'mock' } as unknown as ModelRouter
}

// ── scripted router:按调用次序返不同 blocks(验多轮工具路径)。每条 reply 配 stop_reason ──
function scriptedRouter(opts: {
  turns: { reply: ContentBlock[]; stop_reason?: string }[]
  capture?: ChatParams[]
}): ModelRouter {
  let i = 0
  const chat = async (params: ChatParams): Promise<ChatResponse> => {
    // 快照 messages(数组按引用传,runToolLoop 后续轮会原地 push,不拷贝则断言看到的是最终态)
    opts.capture?.push({ ...params, messages: [...params.messages] })
    const turn = opts.turns[Math.min(i, opts.turns.length - 1)]!
    i++
    return {
      id: `mock-${i}`,
      content: turn.reply,
      stop_reason: turn.stop_reason ?? 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    }
  }
  return { chat, primaryName: 'mock' } as unknown as ModelRouter
}

function makeSubCtx(extra: Partial<ToolContext> = {}): { ctx: ToolContext; logs: string[] } {
  const logs: string[] = []
  const ctx = {
    config: {} as MuConfig,
    dataDir: '/tmp/subagent-test',
    log: (m: string) => logs.push(m),
    depth: 1, // 子代理上下文 depth=1
    ...extra,
  } as ToolContext
  return { ctx, logs }
}

// 装一个最小 registry:一个白名单工具 + 一个黑名单工具(message_send),验 subsetFor 剔除。
function makeRegistry(): { registry: ToolRegistry; webCalls: number } {
  const state = { webCalls: 0 }
  const webSearch: ToolDef = {
    name: 'web_search', description: 'w', parameters: { q: { type: 'string' } },
    async execute() { state.webCalls++; return { success: true, output: 'hit' } },
  }
  const messageSend: ToolDef = {
    name: 'message_send', description: 'm', parameters: {},
    async execute() { return { success: true, output: 'sent' } },
  }
  const registry = new ToolRegistry()
  registry.register(webSearch, { reserved: true })
  registry.register(messageSend, { reserved: true })
  return { registry, webCalls: state.webCalls }
}

// ── 隔离:worker 跑完,传入的本地 messages 数组不被外部 session 持有;noop 回调不落任何外部状态 ──
test('runSubagent worker:本地 messages 隔离 —— 无 onAssistant/session 副作用,跑完返结论', async () => {
  const { registry } = makeRegistry()
  const { ctx } = makeSubCtx()
  const captured: ChatParams[] = []
  const router = mockRouter({ capture: captured })

  const r = await runSubagent(
    { role: 'worker', prompt: '查一下 X 是什么', allowTools: ['web_search'] },
    ctx, router, registry,
  )

  assert.equal(r.role, 'worker')
  assert.equal(r.success, true)
  assert.equal(r.stopReason, 'done')
  assert.ok(r.output.includes('子代理结论'))
  // 隔离证据:发给 router 的 messages 起点是子代理本地数组(只有任务 prompt,看不到主对话历史)
  assert.equal(captured.length, 1)
  assert.equal(captured[0]!.messages[0]!.role, 'user')
  assert.equal(captured[0]!.messages[0]!.content, '查一下 X 是什么')
  // maxTokens 走子代理收紧值
  assert.equal(captured[0]!.max_tokens, SUBAGENT_MAX_TOKENS)
})

// ── fail-open(runner):runToolLoop 内 chat 抛 → runSubagent 不抛,返 success:false stopReason:error ──
test('runSubagent worker:chat 抛异常 → fail-open 返 success:false 不冒泡', async () => {
  const { registry } = makeRegistry()
  const { ctx, logs } = makeSubCtx()
  const router = mockRouter({ throwOnChat: true })

  // 关键:不 reject,正常 resolve 一个失败结果
  const r = await runSubagent({ role: 'worker', prompt: '干活' }, ctx, router, registry)
  assert.equal(r.success, false)
  assert.equal(r.stopReason, 'error')
  assert.ok(r.note?.includes('子代理异常'))
  assert.ok(logs.some(l => l.includes('fail-open')))
})

// ── reviewer:复用 runSelfReview,fail 时 verdict=fail 但 success 仍 true(给的是判断,不是跑没跑通)──
test('runSubagent reviewer:无 dod → runSelfReview 放行 verdict=pass,success=true', async () => {
  const { registry } = makeRegistry()
  const { ctx } = makeSubCtx()
  const router = mockRouter({})
  // 空 dod → runSelfReview 直接放行(不打 router)
  const r = await runSubagent({ role: 'reviewer', prompt: '某产出' }, ctx, router, registry)
  assert.equal(r.role, 'reviewer')
  assert.equal(r.success, true)
  assert.equal(r.verdict, 'pass')
})

// ── buildSubagentRouter:无 primary/fallback → 返 null(调用方据此降级,不打网络)──
test('buildSubagentRouter:config 残缺 → null', () => {
  assert.equal(buildSubagentRouter({} as MuConfig), null)
  assert.equal(buildSubagentRouter({ model: {} } as MuConfig), null)
})

// ── subsetFor:黑名单工具被剔(传了 message_send 也不在结果里),白名单工具保留 ──
test('registry.subsetFor:黑名单 message_send 被永久剔除,即使 allowTools 传了', () => {
  const { registry } = makeRegistry()
  const sub = registry.subsetFor(['web_search', 'message_send'])
  const names = sub.map(t => t.name)
  assert.ok(names.includes('web_search'))
  assert.ok(!names.includes('message_send'))
})

test('registry.subsetFor:不在白名单的工具不返回(交集语义)', () => {
  const { registry } = makeRegistry()
  const sub = registry.subsetFor(['web_search'])
  assert.deepEqual(sub.map(t => t.name), ['web_search'])
  // 空白名单 → 空集
  assert.equal(registry.subsetFor([]).length, 0)
})

// ── depth 硬闸:depth>=MAX_SUBAGENT_DEPTH 的 ctx 调 spawn → 直接拒,不烧模型 ──
test('spawn_subagent:depth>=1 → 直接拒(递归硬闸,不烧模型)', async () => {
  resetSubagentTaskBudget()
  const { registry } = makeRegistry()
  bindRegistry(registry)
  const { ctx } = makeSubCtx({ depth: MAX_SUBAGENT_DEPTH }) // depth=1
  const r = await spawnSubagentTool.execute({ role: 'worker', prompt: '再 spawn' }, ctx)
  assert.equal(r.success, false)
  assert.ok(r.error?.includes('不能再 spawn'))
})

// ── 并发闸:活跃数已达上限时再 spawn → 拒。用一个永不 resolve 的 router 占住并发位 ──
test('spawn_subagent:并发达上限 → 第 N+1 个拒;占位释放后又能 spawn(finally 必减)', async () => {
  resetSubagentTaskBudget()
  const { registry } = makeRegistry()
  bindRegistry(registry)

  // 占位 router:chat 挂起,直到我们手动放行,用来把 activeSubagents 顶到上限
  let release!: () => void
  const gate = new Promise<void>(res => { release = res })
  const hangRouter: ChatParams[] = []
  const hangingChat = async (p: ChatParams): Promise<ChatResponse> => {
    hangRouter.push(p)
    await gate
    return { id: 'h', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
  }
  // 给一个能配出真 router 的 config(forProvider 只构造 provider,不打网络),但我们要让它用 hangingChat:
  // 简单做法 —— monkey-patch:让工具内 buildSubagentRouter 取到的 router.chat 走 hangingChat。
  // 这里改走直接测 runSubagent 的并发由工具计数控制,故构造一个 config 让 buildSubagentRouter 成功,
  // 再把 ModelRouter.prototype.chat 临时替换。
  const realConfig = {
    model: { primary: { name: 'p', format: 'openai', base_url: 'x', api_key: 'x', model: 'm' } },
  } as MuConfig
  const { ModelRouter } = await import('../providers/router.js')
  const origChat = ModelRouter.prototype.chat
  ;(ModelRouter.prototype as unknown as { chat: typeof hangingChat }).chat = hangingChat

  try {
    const ctxA = makeSubCtx({ depth: 0, config: realConfig }).ctx
    const ctxB = makeSubCtx({ depth: 0, config: realConfig }).ctx
    const ctxC = makeSubCtx({ depth: 0, config: realConfig }).ctx

    // 启动 MAX_SUBAGENT_CONCURRENT 个挂起的 spawn(不 await,占住并发位)
    const p1 = spawnSubagentTool.execute({ role: 'worker', prompt: 't1', allowTools: [] }, ctxA)
    const p2 = spawnSubagentTool.execute({ role: 'worker', prompt: 't2', allowTools: [] }, ctxB)
    // 等它们进到 chat(并发位已占)
    await waitFor(() => hangRouter.length >= MAX_SUBAGENT_CONCURRENT)

    // 第 MAX_SUBAGENT_CONCURRENT+1 个:并发满 → 拒(此时总数还没撞 PER_TASK)
    const rReject = await spawnSubagentTool.execute({ role: 'worker', prompt: 't3', allowTools: [] }, ctxC)
    assert.equal(rReject.success, false)
    assert.ok(rReject.error?.includes('并发上限'))

    // 放行占位的,finally 必减并发位
    release()
    await Promise.all([p1, p2])

    // 并发位已释放 → 又能 spawn(证明 finally 减成功,没泄漏)
    const ctxD = makeSubCtx({ depth: 0, config: realConfig }).ctx
    const rAfter = await spawnSubagentTool.execute({ role: 'worker', prompt: 't4', allowTools: [] }, ctxD)
    // 此时累计 spawn=3(t1/t2/t4),未撞 PER_TASK(4),应成功
    assert.equal(rAfter.success, true)
  } finally {
    ModelRouter.prototype.chat = origChat
    resetSubagentTaskBudget()
  }
})

// ── 总数闸:单 cycle 累计 spawn 撞 MAX_SUBAGENTS_PER_TASK → 拒;reset 后恢复 ──
test('spawn_subagent:累计达 MAX_SUBAGENTS_PER_TASK → 拒;resetSubagentTaskBudget 后恢复', async () => {
  resetSubagentTaskBudget()
  const { registry } = makeRegistry()
  bindRegistry(registry)
  const realConfig = {
    model: { primary: { name: 'p', format: 'openai', base_url: 'x', api_key: 'x', model: 'm' } },
  } as MuConfig

  const { ModelRouter } = await import('../providers/router.js')
  const origChat = ModelRouter.prototype.chat
  ;(ModelRouter.prototype as unknown as { chat: () => Promise<ChatResponse> }).chat = async () => ({
    id: 'q', content: [{ type: 'text', text: '结论' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
  })

  try {
    // 串行跑满 MAX_SUBAGENTS_PER_TASK 个(每个跑完并发位即释放,只累加总数)
    for (let i = 0; i < MAX_SUBAGENTS_PER_TASK; i++) {
      const ctx = makeSubCtx({ depth: 0, config: realConfig }).ctx
      const r = await spawnSubagentTool.execute({ role: 'worker', prompt: `t${i}`, allowTools: [] }, ctx)
      assert.equal(r.success, true)
    }
    // 第 N+1 个:总数撞顶 → 拒
    const ctxOver = makeSubCtx({ depth: 0, config: realConfig }).ctx
    const rOver = await spawnSubagentTool.execute({ role: 'worker', prompt: 'over', allowTools: [] }, ctxOver)
    assert.equal(rOver.success, false)
    assert.ok(rOver.error?.includes('上限'))

    // reset(模拟新 cycle)后又能 spawn
    resetSubagentTaskBudget()
    const ctxNew = makeSubCtx({ depth: 0, config: realConfig }).ctx
    const rNew = await spawnSubagentTool.execute({ role: 'worker', prompt: 'new', allowTools: [] }, ctxNew)
    assert.equal(rNew.success, true)
  } finally {
    ModelRouter.prototype.chat = origChat
    resetSubagentTaskBudget()
  }
})

// ── fail-open 延伸(工具层):worker 没跑通,工具仍返 success:true + "请你自己接手" ──
test('spawn_subagent:worker 未完成 → 工具 fail-open 返 success:true + 请自己接手', async () => {
  resetSubagentTaskBudget()
  const { registry } = makeRegistry()
  bindRegistry(registry)
  const realConfig = {
    model: { primary: { name: 'p', format: 'openai', base_url: 'x', api_key: 'x', model: 'm' } },
  } as MuConfig

  const { ModelRouter } = await import('../providers/router.js')
  const origChat = ModelRouter.prototype.chat
  // chat 抛 → runSubagent 返 success:false → 工具 fail-open 成 success:true + 接手提示
  ;(ModelRouter.prototype as unknown as { chat: () => Promise<ChatResponse> }).chat = async () => { throw new Error('boom') }

  try {
    const ctx = makeSubCtx({ depth: 0, config: realConfig }).ctx
    const r = await spawnSubagentTool.execute({ role: 'worker', prompt: '干活' }, ctx)
    assert.equal(r.success, true) // 主 cycle 视角:成功的工具调用返回了失败内容
    assert.ok(r.output.includes('请你自己接手'))
  } finally {
    ModelRouter.prototype.chat = origChat
    resetSubagentTaskBudget()
  }
})

// ── 逻辑拒绝:无模型 → success:false(只有 depth/并发/总数/无模型才 false)──
test('spawn_subagent:buildSubagentRouter 返 null(无模型)→ success:false 降级', async () => {
  resetSubagentTaskBudget()
  const { registry } = makeRegistry()
  bindRegistry(registry)
  const ctx = makeSubCtx({ depth: 0, config: {} as MuConfig }).ctx // 空 config → buildSubagentRouter null
  const r = await spawnSubagentTool.execute({ role: 'worker', prompt: '干活' }, ctx)
  assert.equal(r.success, false)
  assert.ok(r.error?.includes('无可用模型'))
})

// 带实时调用计数的 registry:多轮/子集测试要断言工具到底有没有被真调到。
// (makeRegistry 返回的 webCalls 是快照=0,这里返回 live 对象。)
function makeCountingRegistry(): {
  registry: ToolRegistry
  calls: { web: number; webInputs: Record<string, unknown>[]; send: number }
} {
  const calls = { web: 0, webInputs: [] as Record<string, unknown>[], send: 0 }
  const webSearch: ToolDef = {
    name: 'web_search', description: 'w', parameters: { q: { type: 'string' } },
    async execute(input) { calls.web++; calls.webInputs.push(input); return { success: true, output: '检索命中:答案是 42' } },
  }
  const messageSend: ToolDef = {
    name: 'message_send', description: 'm', parameters: { text: { type: 'string' } },
    async execute() { calls.send++; return { success: true, output: 'sent' } },
  }
  const registry = new ToolRegistry()
  registry.register(webSearch, { reserved: true })
  registry.register(messageSend, { reserved: true })
  return { registry, calls }
}

const toolUse = (id: string, name: string, input: Record<string, unknown> = {}): ContentBlock =>
  ({ type: 'tool_use', id, name, input })

// ── Fix 1(孤儿块)— worker 多轮工具:turn1 tool_use → turn2 text。本地 messages 累积成对,第二轮无孤儿块,不 400 ──
test('runSubagent worker 多轮:tool_use→text 本地 messages 成对累积,第二轮无孤儿 tool_result', async () => {
  const { registry, calls } = makeCountingRegistry()
  const { ctx } = makeSubCtx()
  const captured: ChatParams[] = []
  const router = scriptedRouter({
    turns: [
      // turn1:发一个 web_search 的 tool_use(stop_reason 仍 end_turn,runToolLoop 看 tool_use 块决定续轮)
      { reply: [toolUse('call-1', 'web_search', { q: 'X' })] },
      // turn2:纯文本结论
      { reply: [{ type: 'text', text: '子代理结论:答案是 42' }] },
    ],
    capture: captured,
  })

  const r = await runSubagent(
    { role: 'worker', prompt: '查一下 X', allowTools: ['web_search'] },
    ctx, router, registry,
  )

  // 工具真被调,且拿到了输入
  assert.equal(calls.web, 1)
  assert.deepEqual(calls.webInputs[0], { q: 'X' })
  // 跑了两轮,正常停,拿到最终 text
  assert.equal(captured.length, 2)
  assert.equal(r.success, true)
  assert.equal(r.stopReason, 'done')
  assert.ok(r.output.includes('答案是 42'))

  // 关键(防孤儿块):第二轮发给 router 的 messages = [user(prompt), assistant(tool_use), user(tool_result)]
  const turn2Messages = captured[1]!.messages
  assert.equal(turn2Messages.length, 3)
  assert.equal(turn2Messages[0]!.role, 'user')      // 任务 prompt
  assert.equal(turn2Messages[1]!.role, 'assistant') // 带 tool_use 的 assistant 块(旧 noop 实现这里缺失=孤儿)
  const asstBlocks = turn2Messages[1]!.content as ContentBlock[]
  assert.ok(Array.isArray(asstBlocks))
  assert.equal(asstBlocks[0]!.type, 'tool_use')
  assert.equal(asstBlocks[0]!.id, 'call-1')
  // tool_result 紧跟在配对的 assistant 之后,且 tool_use_id 对得上(无孤儿)
  assert.equal(turn2Messages[2]!.role, 'user')
  const trBlocks = turn2Messages[2]!.content as ContentBlock[]
  assert.equal(trBlocks[0]!.type, 'tool_result')
  assert.equal(trBlocks[0]!.tool_use_id, 'call-1')
})

// ── Fix 2(超时真停)— shouldCancel 触发后 runToolLoop 带现有结果收尾,stopReason='cancelled',不跑满 maxTurns ──
test('runToolLoop:shouldCancel 触发后下一轮停 → stopReason=cancelled,不跑满 maxTurns', async () => {
  const { registry } = makeCountingRegistry()
  const { ctx } = makeSubCtx()
  const captured: ChatParams[] = []
  // 每轮都返 tool_use(永远不会自然停),只靠 shouldCancel 截停
  const router = scriptedRouter({
    turns: [{ reply: [toolUse('c', 'web_search', { q: 'loop' })] }],
    capture: captured,
  })

  let cancelled = false
  const localMessages: ChatMessage[] = [{ role: 'user', content: '一直跑' }]
  const result = await runToolLoop({
    system: 'sys',
    messages: localMessages,
    tools: registry.subsetFor(['web_search']),
    router,
    maxTurns: 6,
    budgetMs: 999_999,
    maxTokens: 100,
    executeTool: (name, input) => registry.execute(name, input, ctx),
    onAssistant: (m) => localMessages.push(m),
    onToolResult: (m) => { localMessages.push(m); cancelled = true }, // 第一轮工具跑完即"超时"
    rebuildMessages: () => localMessages,
    shouldCancel: () => cancelled,
  })

  assert.equal(result.stopReason, 'cancelled')
  assert.ok(result.turns < 6, `应在 maxTurns 前停,实得 turns=${result.turns}`)
  assert.equal(result.turns, 1) // 只跑完第一轮(产出 tool_result),第二轮开头被 cancel 截停
  assert.equal(captured.length, 1) // 没起第二轮 chat
})

test('runToolLoop:chat 等待期间被取消 → 返回后不执行迟到的工具副作用', async () => {
  const { registry, calls } = makeCountingRegistry()
  const { ctx } = makeSubCtx()
  let cancelled = false
  const router = {
    primaryName: 'mock',
    chat: async () => {
      cancelled = true
      return {
        id: 'late',
        content: [toolUse('late-tool', 'web_search', { q: 'late' })],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
      }
    },
  } as unknown as ModelRouter
  const r = await runToolLoop({
    system: 'sys',
    messages: [{ role: 'user', content: 'x' }],
    tools: registry.subsetFor(['web_search']),
    router,
    maxTurns: 2,
    budgetMs: 1000,
    maxTokens: 100,
    executeTool: (name, input) => registry.execute(name, input, ctx),
    shouldCancel: () => cancelled,
  })
  assert.equal(r.stopReason, 'cancelled')
  assert.equal(r.toolCallCount, 0)
  assert.equal(calls.web, 0, '取消后迟到的 tool_use 不能产生副作用')
})

test('runToolLoop:把 AbortSignal 透传给 provider chat', async () => {
  const controller = new AbortController()
  let seen: AbortSignal | undefined
  const router = {
    primaryName: 'mock',
    chat: async (params: ChatParams) => {
      seen = params.signal
      return { id: 'x', content: [{ type: 'text', text: 'done' }], stop_reason: 'end', usage: { input_tokens: 1, output_tokens: 1 } }
    },
  } as unknown as ModelRouter
  await runToolLoop({
    system: 'sys',
    messages: [{ role: 'user', content: 'x' }],
    tools: [],
    router,
    maxTurns: 1,
    budgetMs: 1000,
    maxTokens: 100,
    abortSignal: controller.signal,
    executeTool: async () => ({ success: true, output: '' }),
  })
  assert.equal(seen, controller.signal)
})

test('runToolLoop:同轮全部标记为 parallel-safe 的工具并行执行并保持结果顺序', async () => {
  let turn = 0
  let active = 0
  let peak = 0
  const router = {
    primaryName: 'mock',
    chat: async () => ({
      id: 'p',
      content: turn++ === 0
        ? [toolUse('a', 'read_a'), toolUse('b', 'read_b')]
        : [{ type: 'text', text: 'done' }],
      stop_reason: 'end',
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  } as unknown as ModelRouter
  const results: ChatMessage[] = []
  await runToolLoop({
    system: 'sys',
    messages: [{ role: 'user', content: 'x' }],
    tools: [],
    router,
    maxTurns: 2,
    budgetMs: 1000,
    maxTokens: 100,
    canExecuteInParallel: names => names.every(n => n.startsWith('read_')),
    executeTool: async (name) => {
      active++
      peak = Math.max(peak, active)
      await new Promise(r => setTimeout(r, name === 'read_a' ? 15 : 5))
      active--
      return { success: true, output: name }
    },
    onToolResult: m => results.push(m),
  })
  assert.equal(peak, 2)
  const blocks = results[0]!.content as ContentBlock[]
  assert.deepEqual(blocks.map(b => b.tool_use_id), ['a', 'b'])
})

// ── Fix 3(子集物理隔离)— executeTool 调一个不在子集的 name → 返 success:false,真工具不被执行 ──
test('runSubagent worker:幻觉出黑名单工具名(message_send)→ executeTool 物理拒,真工具不执行', async () => {
  const { registry, calls } = makeCountingRegistry()
  const { ctx } = makeSubCtx()
  const captured: ChatParams[] = []
  // turn1:模型幻觉发了个 message_send 的 tool_use(子集只给了 web_search);turn2:纯文本收尾
  const router = scriptedRouter({
    turns: [
      { reply: [toolUse('bad-1', 'message_send', { text: '偷发' })] },
      { reply: [{ type: 'text', text: '好的我自己写结论' }] },
    ],
    capture: captured,
  })

  const r = await runSubagent(
    { role: 'worker', prompt: '干活', allowTools: ['web_search'] }, // 子集只含 web_search
    ctx, router, registry,
  )

  // message_send 的真 execute 一次都没跑(物理隔离,不靠 LLM 不幻觉)
  assert.equal(calls.send, 0)
  // 第二轮的 tool_result 里带的是拒绝错误(回灌给模型,不中断)
  const turn2Messages = captured[1]!.messages
  const trBlocks = turn2Messages[2]!.content as ContentBlock[]
  assert.equal(trBlocks[0]!.type, 'tool_result')
  assert.ok(String(trBlocks[0]!.content).includes('无权调用'))
  // worker 仍正常收尾(拒绝是 fail-open 的 tool_result,不抛)
  assert.equal(r.stopReason, 'done')
})

// ── Fix 2 配套(clearTimeout)— worker 正常跑完后哨兵被清,进程不被悬空 120s timer 拖住 ──
// 整个 subagent.test.ts 在 --test(无 force-exit)下能正常退出即为证;这里再断言一次 worker 多轮跑完拿到结果,
// 跑完后没有 120s 哨兵驻留(若没 clearTimeout,本文件会像修复前那样挂到 120s 才退)。
test('runSubagent worker:跑完后超时哨兵被 clearTimeout(进程不被悬空 timer 拖住)', async () => {
  const { registry } = makeCountingRegistry()
  const { ctx } = makeSubCtx()
  const router = scriptedRouter({
    turns: [
      { reply: [toolUse('c1', 'web_search', { q: 'q' })] },
      { reply: [{ type: 'text', text: '结论 OK' }] },
    ],
  })
  const t0 = Date.now()
  const r = await runSubagent({ role: 'worker', prompt: '查', allowTools: ['web_search'] }, ctx, router, registry)
  // 微秒级返回(远小于 SUBAGENT_TIMEOUT_MS=120s),证明没等哨兵
  assert.ok(Date.now() - t0 < 5_000, `worker 应秒回,实得 ${Date.now() - t0}ms`)
  assert.equal(r.success, true)
})

// ════════════════════════════════════════════════════════════════════════
// B1: runSubagentsParallel —— 并行分批 + 父 cycle 闸复用 + allSettled 容错
// ════════════════════════════════════════════════════════════════════════

// 一个 worker 自然停的 scripted router 工厂:每个 worker 各自 turn1 web_search → turn2 文本结论。
// 关键:turn 计数按 prompt(messages[0])分桶——一个 router 实例被 N 个并行 worker 共用,
// 共享计数会串台(worker A 的 turn1 被 worker B 的 turn2 顶掉)。按 prompt 隔离才能让每个 worker 各跑满 2 轮。
// onChat 钩子在每次 chat 入口调(用来观测并发位:此刻 worker 持有一个 concurrency slot)。
function workerRouter(opts: {
  inputTokens?: number
  onChat?: () => void
}): ModelRouter {
  const turnByPrompt: Record<string, number> = {}
  const chat = async (p: ChatParams): Promise<ChatResponse> => {
    opts.onChat?.()
    const prompt = String(p.messages[0]!.content as string)
    const n = turnByPrompt[prompt] ?? 0
    turnByPrompt[prompt] = n + 1
    const turn: ContentBlock = n === 0
      ? { type: 'tool_use', id: `c-${prompt}`, name: 'web_search', input: { q: 'x' } }
      : { type: 'text', text: `结论:${prompt} done` }
    return {
      id: 'r', content: [turn], stop_reason: 'end_turn',
      usage: { input_tokens: opts.inputTokens ?? 10, output_tokens: 5 },
    }
  }
  return { chat, primaryName: 'mock' } as unknown as ModelRouter
}

const workerSpec = (prompt: string): { role: 'worker'; prompt: string; allowTools: string[] } =>
  ({ role: 'worker', prompt, allowTools: ['web_search'] })

// ── 分批:4 个 spec、并发上限 2 → 任一时刻在飞 worker 数不超 2(按 MAX_SUBAGENT_CONCURRENT 切批)──
test('runSubagentsParallel:4 个 spec 按 MAX_SUBAGENT_CONCURRENT 分批,峰值并发不超 2', async () => {
  resetBudget()
  const { registry } = makeCountingRegistry()
  const { ctx } = makeSubCtx({ depth: 1 })
  let maxConcurrent = 0
  // 每次进 chat 记录此刻并发位(worker 已 acquire),取峰值
  const router = workerRouter({ onChat: () => { maxConcurrent = Math.max(maxConcurrent, getActiveSubagents()) } })

  const specs = [workerSpec('a'), workerSpec('b'), workerSpec('c'), workerSpec('d')]
  const results = await runSubagentsParallel(specs, ctx, router, registry)

  assert.equal(results.length, 4, '4 个 spec 全有结果')
  assert.ok(results.every(r => r.success), '全部成功')
  assert.ok(maxConcurrent <= MAX_SUBAGENT_CONCURRENT, `峰值并发 ${maxConcurrent} 应 <= ${MAX_SUBAGENT_CONCURRENT}`)
  assert.ok(maxConcurrent >= 2, `应真并行(峰值 ${maxConcurrent} 应达到 2)`)
  // 跑完并发位清零(finally 必减,无泄漏)
  assert.equal(getActiveSubagents(), 0, '跑完并发位归零')
})

// ── allSettled 容错:一个 spec 的 chat 抛 → 该 spec success:false,其余照常成功(不被拖垮)──
test('runSubagentsParallel:一个失败不拖垮其余(allSettled + runner fail-open)', async () => {
  resetBudget()
  const { registry } = makeCountingRegistry()
  const { ctx } = makeSubCtx({ depth: 1 })

  // 第二个 spec 用一个 chat 抛异常的 router;另两个正常。runSubagentsParallel 对所有 spec 用同一个 router,
  // 故这里用一个"按 prompt 决定抛不抛"的 router。
  const router = (() => {
    const callsByPrompt: Record<string, number> = {}
    const chat = async (p: ChatParams): Promise<ChatResponse> => {
      const prompt = String((p.messages[0]!.content as string))
      callsByPrompt[prompt] = (callsByPrompt[prompt] ?? 0) + 1
      if (prompt === 'fail') throw new Error('这个子任务挂了')
      return { id: 'r', content: [{ type: 'text', text: `结论:${prompt} done` }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }
    }
    return { chat, primaryName: 'mock' } as unknown as ModelRouter
  })()

  const results = await runSubagentsParallel(
    [workerSpec('ok1'), workerSpec('fail'), workerSpec('ok2')],
    ctx, router, registry,
  )

  assert.equal(results.length, 3)
  assert.equal(results[0]!.success, true, 'ok1 成功')
  assert.equal(results[1]!.success, false, 'fail 失败(fail-open 成 success:false,不抛)')
  assert.equal(results[1]!.stopReason, 'error')
  assert.equal(results[2]!.success, true, 'ok2 不被 fail 拖垮')
  assert.equal(getActiveSubagents(), 0, '即使有失败,并发位也归零(finally 必减)')
})

// ── 总数闸:父 cycle 已 spawn 满 MAX_SUBAGENTS_PER_TASK → 并行里后续 spec 被拒(success:false),不烧模型 ──
test('runSubagentsParallel:撞 MAX_SUBAGENTS_PER_TASK 后续 spec 拒,不烧模型', async () => {
  resetBudget()
  const { registry } = makeCountingRegistry()
  const { ctx } = makeSubCtx({ depth: 1 })
  let chatCalls = 0
  const router = workerRouter({ onChat: () => { chatCalls++ } })

  // 5 个 spec,总数闸=4 → 第 5 个被拒(不进 chat)
  const specs = Array.from({ length: MAX_SUBAGENTS_PER_TASK + 1 }, (_, i) => workerSpec(`t${i}`))
  const results = await runSubagentsParallel(specs, ctx, router, registry)

  assert.equal(results.length, MAX_SUBAGENTS_PER_TASK + 1)
  const ok = results.filter(r => r.success).length
  const rejected = results.filter(r => !r.success)
  assert.equal(ok, MAX_SUBAGENTS_PER_TASK, `只有 ${MAX_SUBAGENTS_PER_TASK} 个真跑`)
  assert.equal(rejected.length, 1, '1 个被总数闸拒')
  assert.equal(rejected[0]!.stopReason, 'budget')
  assert.ok(rejected[0]!.note?.includes('上限'))
  // 被拒的没烧模型:chat 调用次数 = 4 个 worker × 2 轮 = 8(第 5 个一次都没进 chat)
  assert.equal(chatCalls, MAX_SUBAGENTS_PER_TASK * 2, '被拒 spec 不进 chat')
  assert.equal(getActiveSubagents(), 0)
})

// ── input 预算闸:父 cycle 累计 input 撞 SUBAGENT_INPUT_BUDGET → 后续 spec 拒(成本主闸)──
test('runSubagentsParallel:撞 SUBAGENT_INPUT_BUDGET 后续 spec 拒(input 预算闸)', async () => {
  resetBudget()
  const { registry } = makeCountingRegistry()
  const { ctx } = makeSubCtx({ depth: 1 })
  // 每个 worker 两轮、每轮 input = 大半个预算 → 头一两个就把 80k 累加撞顶,后续拒
  const perChat = Math.ceil(SUBAGENT_INPUT_BUDGET / 2) // 单 worker 两轮 ≈ 满预算
  const router = workerRouter({ inputTokens: perChat })

  // 4 个 spec(不撞总数闸),但 input 预算会先撞顶 → 后面的拒
  const specs = [workerSpec('a'), workerSpec('b'), workerSpec('c'), workerSpec('d')]
  const results = await runSubagentsParallel(specs, ctx, router, registry)

  const budgetRejected = results.filter(r => !r.success && r.note?.includes('预算'))
  assert.ok(budgetRejected.length >= 1, '至少一个被 input 预算闸拒')
  assert.ok(budgetRejected.every(r => r.stopReason === 'budget'))
  assert.equal(getActiveSubagents(), 0, '预算拒后并发位仍归零')
})

// ── 计数器 finally 必减不泄漏:连续两批并行跑完,activeSubagents 始终回到 0;reset 后总数闸恢复 ──
test('runSubagentsParallel:连续多批跑完并发位不泄漏,reset 后总数闸恢复', async () => {
  resetBudget()
  const { registry } = makeCountingRegistry()
  const { ctx } = makeSubCtx({ depth: 1 })
  const router = workerRouter({})

  // 第一批:2 个(未撞总数闸)
  const r1 = await runSubagentsParallel([workerSpec('a'), workerSpec('b')], ctx, router, registry)
  assert.ok(r1.every(r => r.success))
  assert.equal(getActiveSubagents(), 0, '第一批后归零')

  // 第二批:再 2 个 → 累计 4,刚好到总数闸上限(仍全成功)
  const r2 = await runSubagentsParallel([workerSpec('c'), workerSpec('d')], ctx, router, registry)
  assert.ok(r2.every(r => r.success), '累计到 4 仍全成功(刚好上限)')
  assert.equal(getActiveSubagents(), 0, '第二批后仍归零')

  // 第三批:总数已满 → 全被拒(不泄漏并发位)
  const r3 = await runSubagentsParallel([workerSpec('e')], ctx, router, registry)
  assert.equal(r3[0]!.success, false, '总数满 → 拒')
  assert.equal(getActiveSubagents(), 0)

  // reset(模拟新 cycle)→ 总数闸恢复,又能跑
  resetBudget()
  const r4 = await runSubagentsParallel([workerSpec('f')], ctx, router, registry)
  assert.equal(r4[0]!.success, true, 'reset 后恢复')
  assert.equal(getActiveSubagents(), 0)
})

// ── spawn_parallel 工具:depth 硬闸(子代理不能再并行 spawn)──
test('spawn_parallel:depth>=1 → 直接拒(递归硬闸,不烧模型)', async () => {
  resetSubagentTaskBudget()
  const { registry } = makeRegistry()
  bindRegistry(registry)
  const { ctx } = makeSubCtx({ depth: MAX_SUBAGENT_DEPTH })
  const r = await spawnParallelTool.execute({ tasks: [{ prompt: 'x' }] }, ctx)
  assert.equal(r.success, false)
  assert.ok(r.error?.includes('不能再 spawn'))
})

// ── spawn_parallel 工具:tasks 空 → 逻辑拒 success:false ──
test('spawn_parallel:tasks 空 → success:false(逻辑拒)', async () => {
  resetSubagentTaskBudget()
  const { registry } = makeRegistry()
  bindRegistry(registry)
  const { ctx } = makeSubCtx({ depth: 0 })
  const rEmpty = await spawnParallelTool.execute({ tasks: [] }, ctx)
  assert.equal(rEmpty.success, false)
  assert.ok(rEmpty.error?.includes('tasks 为空'))
  // 全是空 prompt 也算空
  const rBlank = await spawnParallelTool.execute({ tasks: [{ prompt: '  ' }] }, ctx)
  assert.equal(rBlank.success, false)
})

// ── spawn_parallel 工具:整体跑完返 success:true + 可读汇总(fail-open 延伸,主代理合成)──
test('spawn_parallel:跑完返 success:true + 各子任务汇总(给主代理合成)', async () => {
  resetSubagentTaskBudget()
  const { registry } = makeCountingRegistry()
  bindRegistry(registry)
  const realConfig = {
    model: { primary: { name: 'p', format: 'openai', base_url: 'x', api_key: 'x', model: 'm' } },
  } as MuConfig

  const { ModelRouter } = await import('../providers/router.js')
  const origChat = ModelRouter.prototype.chat
  let i = 0
  ;(ModelRouter.prototype as unknown as { chat: () => Promise<ChatResponse> }).chat = async () => {
    // 每个 worker 一轮就给文本结论(自然停)
    i++
    return { id: 'r', content: [{ type: 'text', text: `子结论 ${i}` }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }
  }
  try {
    const ctx = makeSubCtx({ depth: 0, config: realConfig }).ctx
    const r = await spawnParallelTool.execute({ tasks: [{ prompt: 'a' }, { prompt: 'b' }] }, ctx)
    assert.equal(r.success, true, '整体 fail-open 成 success:true')
    assert.ok(r.output.includes('子任务 1 完成'))
    assert.ok(r.output.includes('子任务 2 完成'))
  } finally {
    ModelRouter.prototype.chat = origChat
    resetSubagentTaskBudget()
  }
})

// 轮询等待条件(测试用,避免 sleep)
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await new Promise(r => setImmediate(r))
  }
}
