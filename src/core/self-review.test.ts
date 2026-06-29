// self-review.ts 单测:verdict 容错解析、fail-open(router 挂→pass)、reviewGate 轮数上界=2。
// 死亡螺旋红线断言:runSelfReview 异常绝不抛(R6)、reviewGate 第 2 轮强制放行(R7)。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  parseReviewResult, runSelfReview, reviewGate, MAX_REVIEW_ROUNDS,
} from './self-review.js'
import type { MuConfig } from './types.js'
import type { ModelRouter } from '../providers/router.js'
import type { ChatResponse } from '../providers/base.js'

const HERE = dirname(fileURLToPath(import.meta.url))

// 脚本化 router:返回固定文本(模拟模型回复),记录调用次数
function fakeRouter(text: string): { router: ModelRouter; calls: () => number } {
  let calls = 0
  const r = {
    primaryName: 'fake-review',
    chat: async (): Promise<ChatResponse> => {
      calls++
      return { id: 'r', content: [{ type: 'text', text }], stop_reason: 'end', usage: { input_tokens: 1, output_tokens: 1 } }
    },
  }
  return { router: r as unknown as ModelRouter, calls: () => calls }
}

// 永远抛的 router(模拟 router 全挂 / 超时 / 全冷却)
function throwingRouter(): ModelRouter {
  return {
    primaryName: 'boom',
    chat: async () => { throw new Error('router 全挂了') },
  } as unknown as ModelRouter
}

// 最小 config:fallback 留空 → buildReviewRouter 降级用 primary(方案 a)
function cfg(): MuConfig {
  return {
    model: { primary: { name: 'p', format: 'openai', base_url: 'http://127.0.0.1:1', api_key: '', model: 'm' } },
    scheduler: { min_wake_seconds: 120, max_wake_seconds: 3600, max_sleep_seconds: 28800, cron_fallback_seconds: 900, night_min_wake_seconds: 1800, night_start_hour: 23, night_end_hour: 7 },
    agent: { max_turns_per_cycle: 10, session_timeout_minutes: 30 },
    paths: { soul: '/tmp', data: '/tmp', tools: '/tmp/tools' },
  }
}

// ── parseReviewResult:容错解析 ────────────────────────────────

test('parseReviewResult:干净 JSON pass', () => {
  const r = parseReviewResult('{"verdict": "pass", "note": "DoD 都满足"}')
  assert.equal(r.verdict, 'pass')
  assert.equal(r.note, 'DoD 都满足')
})

test('parseReviewResult:干净 JSON fail', () => {
  const r = parseReviewResult('{"verdict": "fail", "note": "缺第二条"}')
  assert.equal(r.verdict, 'fail')
  assert.equal(r.note, '缺第二条')
})

test('parseReviewResult:裹 markdown 代码块也能抠出来', () => {
  const r = parseReviewResult('好的,我的判断是:\n```json\n{"verdict":"fail","note":"没覆盖边界"}\n```\n')
  assert.equal(r.verdict, 'fail')
  assert.equal(r.note, '没覆盖边界')
})

test('parseReviewResult:模型啰嗦+JSON 不规整 → 文本兜底认出 fail', () => {
  const r = parseReviewResult('这份产出 verdict 我给 fail,因为没写测试')
  assert.equal(r.verdict, 'fail')
})

test('parseReviewResult:JSON 烂掉且无 fail 信号 → fail-open 返 pass', () => {
  const r = parseReviewResult('{verdict: 不是合法json 而且没有失败字样')
  assert.equal(r.verdict, 'pass')
})

test('parseReviewResult:空输出 → fail-open 返 pass', () => {
  assert.equal(parseReviewResult('').verdict, 'pass')
  assert.equal(parseReviewResult('   ').verdict, 'pass')
})

test('parseReviewResult:verdict 字段是怪值(approve)→ 无 fail 信号 fail-open pass', () => {
  const r = parseReviewResult('{"verdict":"approve","note":"x"}')
  assert.equal(r.verdict, 'pass')
})

// ── runSelfReview:正常 + fail-open ────────────────────────────

test('runSelfReview:模型返 pass → pass', async () => {
  const { router } = fakeRouter('{"verdict":"pass","note":"ok"}')
  const r = await runSelfReview('DoD: 覆盖三个库', '对比了三个库', router)
  assert.equal(r.verdict, 'pass')
})

test('runSelfReview:模型返 fail → fail', async () => {
  const { router } = fakeRouter('{"verdict":"fail","note":"只对比了两个"}')
  const r = await runSelfReview('DoD: 覆盖三个库', '只写了两个', router)
  assert.equal(r.verdict, 'fail')
  assert.match(r.note, /两个/)
})

test('runSelfReview:dod 为空 → 跳过 review 直接 pass(不调 router)', async () => {
  const { router, calls } = fakeRouter('{"verdict":"fail"}')
  const r = await runSelfReview('', '随便什么产出', router)
  assert.equal(r.verdict, 'pass')
  assert.equal(calls(), 0, 'dod 空时不该调 router')
})

// R6 铁律:router 挂 → fail-open 返 pass,绝不抛异常
test('runSelfReview:router 抛异常 → fail-open 返 pass,不冒泡(R6)', async () => {
  const r = await runSelfReview('DoD: x', 'output', throwingRouter())
  assert.equal(r.verdict, 'pass')
  assert.match(r.note, /放行/)
})

// ── reviewGate:pass / fail / 2 轮强制放行 ──────────────────────

test('reviewGate:无 DoD 不该被调用——这里直接验空 dod 走 runSelfReview 放行', async () => {
  // reviewGate 内部 buildReviewRouter 用 primary;dod 空时 runSelfReview 跳过不调网络
  const g = await reviewGate('', '产出', 0, cfg())
  assert.equal(g.passed, true)
  assert.equal(g.forced, false)
})

// R7 铁律:已经第 MAX-1 轮(=1)再来,直接强制放行,不再烧模型、不无限重做
test('reviewGate:撞 2 轮上界 → 强制放行 + forced=true(R7)', async () => {
  // prevRounds = MAX-1 = 1:这是第 2 次,直接强制放行
  const g = await reviewGate('DoD: x', 'output', MAX_REVIEW_ROUNDS - 1, cfg())
  assert.equal(g.passed, true, '第 2 轮强制放行')
  assert.equal(g.forced, true, '打 forced 标记')
  assert.equal(g.rounds, MAX_REVIEW_ROUNDS, 'rounds 涨到上界')
})

test('reviewGate:verdict=pass → 放行 forced=false,rounds 不涨', async () => {
  const { router } = fakeRouter('{"verdict":"pass","note":"够格"}')
  const g = await reviewGate('DoD: 覆盖三个库', '对比了三个库', 0, cfg(), () => {}, router)
  assert.equal(g.passed, true)
  assert.equal(g.forced, false)
  assert.equal(g.rounds, 0, 'pass 不涨轮数')
})

test('reviewGate:verdict=fail → 不放行,rounds++,带回意见', async () => {
  const { router } = fakeRouter('{"verdict":"fail","note":"只对比了两个库"}')
  const g = await reviewGate('DoD: 覆盖三个库', '只写了两个', 0, cfg(), () => {}, router)
  assert.equal(g.passed, false, '没过不放行')
  assert.equal(g.forced, false)
  assert.equal(g.rounds, 1, 'fail 涨一轮')
  assert.match(g.note, /两个库/)
})

test('reviewGate:第 1 轮 fail 后第 2 轮(rounds=1)直接强制放行,不再调 router(R7)', async () => {
  const { router, calls } = fakeRouter('{"verdict":"fail","note":"还是不行"}')
  const g = await reviewGate('DoD: x', 'output', 1, cfg(), () => {}, router)
  assert.equal(g.passed, true, '第 2 轮强制放行')
  assert.equal(g.forced, true)
  assert.equal(calls(), 0, '撞上界直接放行,不烧模型')
})

test('reviewGate:router=null(取不到模型)→ fail-open 放行', async () => {
  const g = await reviewGate('DoD: x', 'output', 0, cfg(), () => {}, null)
  assert.equal(g.passed, true)
  assert.equal(g.forced, false)
})

test('reviewGate:轮数上界常量 = 2', () => {
  assert.equal(MAX_REVIEW_ROUNDS, 2)
})

// reviewGate 永不抛:即便 config 残缺也走 fail-open(R6 在 gate 层也成立)
test('reviewGate:config 取不到 provider → fail-open 放行,不抛', async () => {
  const broken = { model: {} } as unknown as MuConfig
  const g = await reviewGate('DoD: x', 'output', 0, broken)
  assert.equal(g.passed, true)
})

// ── review 范围边界:普通即时回复(message_send)绝不过 review ──
// 结构断言:message-send.ts 不 import/调用 self-review,普通回复不被 30-120s 的 review 拖慢(Q4 边界)。
test('范围边界:message_send 不接 reviewGate(普通回复不过 review)', () => {
  const src = readFileSync(join(HERE, '../tools/builtin/message-send.ts'), 'utf-8')
  assert.ok(!/self-review|reviewGate|runSelfReview/.test(src), 'message_send 不该引入 review')
})

// 反向确认:只有 task.ts 接了 gate(task 有 deliverable 可审);commitment 是简单承诺无产出物,
// 不套 gate(Phase 4 review 后决策:自我 review 是 task 特性,避免审承诺意图 + recurring 轮数泄漏)。
test('范围边界:只有 task_update 接 reviewGate(commitment 不套)', () => {
  const taskSrc = readFileSync(join(HERE, '../tools/builtin/task.ts'), 'utf-8')
  const commitSrc = readFileSync(join(HERE, '../tools/builtin/memory/commitments.ts'), 'utf-8')
  assert.ok(/reviewGate/.test(taskSrc), 'task.ts 接了 gate')
  assert.ok(!/reviewGate/.test(commitSrc), 'commitment 不该套 gate(简单承诺无产出物)')
})
