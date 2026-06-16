import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAnthropicProvider } from './anthropic.js'
import type { ProviderConfig } from '../core/types.js'
import type { ChatParams } from './base.js'

// ChatParams.system 是必填,用例大多不关心它 → 这里统一补默认
const params = (over: Partial<ChatParams> = {}): ChatParams => ({
  system: 'sys',
  messages: [{ role: 'user', content: 'q' }],
  ...over,
})

// 不发真实网络:替换 globalThis.fetch。Anthropic SDK 无显式 fetch 时走 global,
// 这样既能锁请求体的装配逻辑,又能锁响应解析,全程零网络。
// 注:每个用例自己 install/restore fetch,避免互相污染。

interface Captured { url: string; body: Record<string, unknown> }

function installFetch(respBody: Record<string, unknown>, status = 200): { captured: Captured[]; restore: () => void } {
  const captured: Captured[] = []
  const orig = globalThis.fetch
  globalThis.fetch = (async (url: unknown, init: { body?: string } = {}) => {
    captured.push({ url: String(url), body: init.body ? JSON.parse(init.body) : {} })
    return new Response(JSON.stringify(respBody), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return { captured, restore: () => { globalThis.fetch = orig } }
}

const baseCfg = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  name: 'claude',
  format: 'anthropic',
  base_url: 'https://anthropic.test',
  api_key: 'sk-x',
  model: 'claude-test',
  ...over,
})

const textResp = (text: string, stop = 'end_turn', extra: Record<string, unknown> = {}) => ({
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test',
  content: text === '' ? [] : [{ type: 'text', text }],
  stop_reason: stop, stop_sequence: null,
  usage: { input_tokens: 5, output_tokens: 3, ...extra },
})

// ---- 请求体装配 ----

test('max_tokens: params > config > 默认 4096', async () => {
  // 1) params 优先
  let { captured, restore } = installFetch(textResp('hi'))
  let p = createAnthropicProvider(baseCfg({ max_tokens: 100 }))
  await p.chat(params({ max_tokens: 7 }))
  assert.equal(captured[0]!.body.max_tokens, 7)
  restore()

  // 2) config 次之
  ;({ captured, restore } = installFetch(textResp('hi')))
  p = createAnthropicProvider(baseCfg({ max_tokens: 100 }))
  await p.chat(params())
  assert.equal(captured[0]!.body.max_tokens, 100)
  restore()

  // 3) 默认 4096
  ;({ captured, restore } = installFetch(textResp('hi')))
  p = createAnthropicProvider(baseCfg())
  await p.chat(params())
  assert.equal(captured[0]!.body.max_tokens, 4096)
  restore()
})

test('temperature: 配了才传,没配不出现在请求里', async () => {
  let { captured, restore } = installFetch(textResp('hi'))
  let p = createAnthropicProvider(baseCfg({ temperature: 0.9 }))
  await p.chat(params())
  assert.equal(captured[0]!.body.temperature, 0.9)
  restore()

  ;({ captured, restore } = installFetch(textResp('hi')))
  p = createAnthropicProvider(baseCfg())
  await p.chat(params())
  assert.equal('temperature' in captured[0]!.body, false)
  restore()
})

test('thinking disabled: 仅当 supports_thinking_control 才注入 thinking', async () => {
  // 支持 → 注入
  let { captured, restore } = installFetch(textResp('hi'))
  let p = createAnthropicProvider(baseCfg({ supports_thinking_control: true }))
  await p.chat(params({ thinking: 'disabled' }))
  assert.deepEqual(captured[0]!.body.thinking, { type: 'disabled' })
  restore()

  // 不支持 → 不注入(即便 params 要求 disabled)
  ;({ captured, restore } = installFetch(textResp('hi')))
  p = createAnthropicProvider(baseCfg({ supports_thinking_control: false }))
  await p.chat(params({ thinking: 'disabled' }))
  assert.equal('thinking' in captured[0]!.body, false)
  restore()
})

test('tools: 透传 name/description/input_schema,supports_cache 给末个工具标 cache_control', async () => {
  const { captured, restore } = installFetch(textResp('hi'))
  const p = createAnthropicProvider(baseCfg({ supports_cache: true }))
  await p.chat(params({
    tools: [
      { name: 'a', description: 'da', input_schema: { type: 'object' } },
      { name: 'b', description: 'db', input_schema: { type: 'object' } },
    ],
  }))
  const tools = captured[0]!.body.tools as Array<Record<string, unknown>>
  assert.equal(tools.length, 2)
  assert.equal(tools[0]!.name, 'a')
  assert.equal('cache_control' in tools[0]!, false, '只标最后一个')
  assert.deepEqual(tools[1]!.cache_control, { type: 'ephemeral' })
  restore()
})

test('tools: 不支持 cache 时不标 cache_control', async () => {
  const { captured, restore } = installFetch(textResp('hi'))
  const p = createAnthropicProvider(baseCfg({ supports_cache: false }))
  await p.chat(params({
    tools: [{ name: 'a', description: 'da', input_schema: { type: 'object' } }],
  }))
  const tools = captured[0]!.body.tools as Array<Record<string, unknown>>
  assert.equal('cache_control' in tools[0]!, false)
  restore()
})

test('空 tools 数组: 不出现 tools 字段', async () => {
  const { captured, restore } = installFetch(textResp('hi'))
  const p = createAnthropicProvider(baseCfg())
  await p.chat(params({ tools: [] }))
  assert.equal('tools' in captured[0]!.body, false)
  restore()
})

test('stop_sequences: 配了才透传', async () => {
  const { captured, restore } = installFetch(textResp('hi'))
  const p = createAnthropicProvider(baseCfg())
  await p.chat(params({ stop_sequences: ['STOP'] }))
  assert.deepEqual(captured[0]!.body.stop_sequences, ['STOP'])
  restore()
})

test('system 和 messages 原样进请求体', async () => {
  const { captured, restore } = installFetch(textResp('hi'))
  const p = createAnthropicProvider(baseCfg())
  await p.chat({ system: 'you are mu', messages: [{ role: 'user', content: 'hello' }] })
  assert.equal(captured[0]!.body.system, 'you are mu')
  assert.deepEqual(captured[0]!.body.messages, [{ role: 'user', content: 'hello' }])
  restore()
})

// ---- 响应解析 ----

test('解析 text block → ChatResponse.content', async () => {
  const { restore } = installFetch(textResp('你好', 'end_turn', { cache_read_input_tokens: 9 }))
  const p = createAnthropicProvider(baseCfg())
  const r = await p.chat(params())
  assert.deepEqual(r.content, [{ type: 'text', text: '你好' }])
  assert.equal(r.id, 'msg_1')
  assert.equal(r.stop_reason, 'end_turn')
  assert.equal(r.usage.input_tokens, 5)
  assert.equal(r.usage.output_tokens, 3)
  assert.equal(r.usage.cache_read_input_tokens, 9)
  restore()
})

test('解析 tool_use block,跳过 thinking block', async () => {
  const resp = {
    id: 'msg_2', type: 'message', role: 'assistant', model: 'm',
    content: [
      { type: 'thinking', thinking: '想一想' },
      { type: 'tool_use', id: 'tu_1', name: 'search', input: { q: 'x' } },
      { type: 'text', text: '结果' },
    ],
    stop_reason: 'tool_use', stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 2 },
  }
  const { restore } = installFetch(resp)
  const p = createAnthropicProvider(baseCfg())
  const r = await p.chat(params())
  // thinking 被跳过,只剩 tool_use + text
  assert.equal(r.content.length, 2)
  assert.deepEqual(r.content[0], { type: 'tool_use', id: 'tu_1', name: 'search', input: { q: 'x' } })
  assert.deepEqual(r.content[1], { type: 'text', text: '结果' })
  restore()
})

test('max_tokens 截断且无内容 → 抛错(走 fallback,不静默空回复)', async () => {
  const { restore } = installFetch(textResp('', 'max_tokens'))
  const p = createAnthropicProvider(baseCfg())
  await assert.rejects(
    () => p.chat(params()),
    /max_tokens 截断且无可用内容/,
  )
  restore()
})

test('其他 stop_reason 但无内容 → 补空 text,不抛', async () => {
  const { restore } = installFetch(textResp('', 'end_turn'))
  const p = createAnthropicProvider(baseCfg())
  const r = await p.chat(params())
  assert.deepEqual(r.content, [{ type: 'text', text: '' }])
  restore()
})

test('provider.name 来自 config.name', () => {
  const p = createAnthropicProvider(baseCfg({ name: 'fallback-claude' }))
  assert.equal(p.name, 'fallback-claude')
})
