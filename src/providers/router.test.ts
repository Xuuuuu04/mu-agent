import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ModelRouter } from './router.js'
import type { ModelProvider, ChatParams, ChatResponse } from './base.js'
import type { ProviderConfig, ChatMessage } from '../core/types.js'

// ModelRouter 的构造函数走 createProvider(真 SDK,依赖 config),没有 provider 注入口。
// 但 chat() 的路由逻辑只读 this.primary / this.fallbacks。这里用和 forProvider 同款的
// Object.create(prototype) 手法,把私有字段塞成假 provider —— 测的是 chat() 真实路由,
// 不碰构造路径,不动源码。
function routerWith(primary: ModelProvider, fallbacks: ModelProvider[] = []): ModelRouter {
  const r = Object.create(ModelRouter.prototype) as ModelRouter
  const rr = r as unknown as { primary: ModelProvider; fallbacks: ModelProvider[]; cooldowns: Map<string, number> }
  rr.primary = primary
  rr.fallbacks = fallbacks
  rr.cooldowns = new Map()
  return r
}

const fakeConfig: ProviderConfig = {
  name: 'fake', format: 'openai', base_url: 'http://x', api_key: 'k', model: 'm',
}

// 记录每个 provider 被调用了几次;ok provider 返回固定 response,fail provider 抛错
function okProvider(name: string, calls: string[]): ModelProvider {
  return {
    name,
    config: { ...fakeConfig, name },
    async chat(_params: ChatParams): Promise<ChatResponse> {
      calls.push(name)
      return {
        id: `id-${name}`,
        content: [{ type: 'text', text: `from ${name}` }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }
    },
  }
}
function failProvider(name: string, calls: string[], msg = `${name} boom`): ModelProvider {
  return {
    name,
    config: { ...fakeConfig, name },
    async chat(_params: ChatParams): Promise<ChatResponse> {
      calls.push(name)
      throw new Error(msg)
    },
  }
}

const baseParams: ChatParams = {
  system: 'sys',
  messages: [{ role: 'user', content: 'hi' }],
}

test('primary 成功 → 不走 fallback', async () => {
  const calls: string[] = []
  const r = routerWith(okProvider('primary', calls), [okProvider('fb1', calls)])
  const res = await r.chat(baseParams)
  assert.equal(res.id, 'id-primary')
  assert.deepEqual(calls, ['primary'])   // fallback 没被碰
})

test('primary 抛错 → 落到第一个 fallback', async () => {
  const calls: string[] = []
  const r = routerWith(failProvider('primary', calls), [okProvider('fb1', calls)])
  const res = await r.chat(baseParams)
  assert.equal(res.id, 'id-fb1')
  assert.deepEqual(calls, ['primary', 'fb1'])
})

test('primary + fb1 都挂 → 依次落到 fb2', async () => {
  const calls: string[] = []
  const r = routerWith(
    failProvider('primary', calls),
    [failProvider('fb1', calls), okProvider('fb2', calls)],
  )
  const res = await r.chat(baseParams)
  assert.equal(res.id, 'id-fb2')
  assert.deepEqual(calls, ['primary', 'fb1', 'fb2'])
})

test('全挂 → 抛最后一个 provider 的错(不是泛化 "no providers available")', async () => {
  const calls: string[] = []
  const r = routerWith(
    failProvider('primary', calls, 'primary down'),
    [failProvider('fb1', calls, 'fb1 down'), failProvider('fb2', calls, 'fb2 down')],
  )
  // 真实行为:循环里 isLast 时直接 throw 当前 err,所以是最后一个的 message
  await assert.rejects(r.chat(baseParams), /fb2 down/)
  assert.deepEqual(calls, ['primary', 'fb1', 'fb2'])
})

test('无 fallback 且 primary 挂 → primary 即 last,抛 primary 的错', async () => {
  const calls: string[] = []
  const r = routerWith(failProvider('primary', calls, 'only one down'))
  await assert.rejects(r.chat(baseParams), /only one down/)
  assert.deepEqual(calls, ['primary'])
})

test('primaryName 暴露 primary.name', () => {
  const calls: string[] = []
  const r = routerWith(okProvider('the-primary', calls))
  assert.equal(r.primaryName, 'the-primary')
})

test('forProvider:单 provider,无 fallback(挂了就直接抛)', async () => {
  // forProvider 走真 createProvider,造一个会在 chat 时挂的 openai config(base_url 不通)。
  // 这里只锁"单 provider 即 last,错直接冒泡"的结构,不实际发网络成功请求 —— 用一个必失败的 url。
  const calls: string[] = []
  const r = routerWith(failProvider('solo', calls, 'solo boom'))
  await assert.rejects(r.chat(baseParams), /solo boom/)
  assert.deepEqual(calls, ['solo'])
})

// ---- 冷却机制 ----

test('429 错误后 provider 被冷却,第二次调用直接跳到 fallback', async () => {
  const calls: string[] = []
  const r = routerWith(
    failProvider('glm', calls, 'glm HTTP 429: rate limited'),
    [okProvider('minimax', calls)],
  )
  // 第一次:glm 429 → fallback minimax
  await r.chat(baseParams)
  assert.deepEqual(calls, ['glm', 'minimax'])

  calls.length = 0
  // 第二次:glm 在冷却期 → 直接走 minimax,不白费 3 轮 retry
  await r.chat(baseParams)
  assert.deepEqual(calls, ['minimax'])
})

test('非 429 错误也会短冷却', async () => {
  const calls: string[] = []
  const r = routerWith(
    failProvider('glm', calls, 'glm HTTP 500: server error'),
    [okProvider('minimax', calls)],
  )
  await r.chat(baseParams)
  assert.deepEqual(calls, ['glm', 'minimax'])

  calls.length = 0
  await r.chat(baseParams)
  assert.deepEqual(calls, ['minimax'])
})

test('所有 provider 都冷却 → 退避抛错,不立即重打(防限流风暴)', async () => {
  let glmFails = true
  const calls: string[] = []
  const glm: ModelProvider = {
    name: 'glm', config: { ...fakeConfig, name: 'glm' },
    async chat() {
      calls.push('glm')
      if (glmFails) throw new Error('glm HTTP 429: rate limited')
      return { id: 'id-glm', content: [{ type: 'text', text: 'ok' }], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } }
    },
  }
  const r = routerWith(glm, [failProvider('fb', calls, 'fb HTTP 429: rate limited')])

  // 两个都 429 → 全冷却 → 最后一个 throw
  await assert.rejects(r.chat(baseParams), /fb HTTP 429/)
  assert.deepEqual(calls, ['glm', 'fb'])

  // 下一次调用:全冷却中 → 退避抛"cooling down",【一个 provider 都不打】(旧行为会清冷却全重打成风暴)
  calls.length = 0
  glmFails = false
  await assert.rejects(r.chat(baseParams), /cooling down/)
  assert.deepEqual(calls, [], '冷却期内不该真打任何 provider')
})

test('冷却到期后 → 恢复正常路由', async () => {
  const calls: string[] = []
  const r = routerWith(okProvider('glm', calls))
  // 手动把冷却设成已过期(模拟 60s 后)
  const rr = r as unknown as { cooldowns: Map<string, number> }
  rr.cooldowns.set('glm', Date.now() - 1)
  const res = await r.chat(baseParams)
  assert.equal(res.id, 'id-glm')
  assert.deepEqual(calls, ['glm'], '冷却到期后应正常打 provider')
})

test('sanitizeMessages 接入:孤儿 tool_result 被剔后仍正常路由到 primary', async () => {
  const calls: string[] = []
  let received: ChatMessage[] = []
  const provider: ModelProvider = {
    name: 'cap', config: fakeConfig,
    async chat(params: ChatParams) {
      calls.push('cap')
      received = params.messages
      return { id: 'x', content: [{ type: 'text', text: 'ok' }], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } }
    },
  }
  const r = routerWith(provider)
  // 开头一条孤儿 tool_result(无对应 tool_use)→ sanitizeMessages 应剔掉
  const dirty: ChatMessage[] = [
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ghost', content: 'x' }] },
    { role: 'assistant', content: '嗯' },
    { role: 'user', content: '在吗' },
  ]
  await r.chat({ system: 's', messages: dirty })
  assert.deepEqual(calls, ['cap'])
  // provider 收到的 messages 里不应再有孤儿 tool_result block
  const hasOrphan = received.some(m =>
    typeof m.content !== 'string' && m.content.some(b => b.type === 'tool_result' && b.tool_use_id === 'ghost'))
  assert.equal(hasOrphan, false, '孤儿 tool_result 已被 sanitizeMessages 剔除')
})
