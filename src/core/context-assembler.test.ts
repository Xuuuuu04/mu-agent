import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ContextAssembler } from './context-assembler.js'
import type { MuConfig, WakeTrigger, AnthropicTool, IncomingMessage, Task } from './types.js'

// characterization 测试:锁住 assemble() 产出的 system 块顺序与 cache_control 标记。
// 这是头号成本雷区——cache 前缀顺序错了缓存全失效。测真实行为,不测应然。

// 临时 soul + data 目录,绝不碰生产 data/。每个 withDirs 用 finally 清理。
function withDirs(
  fn: (dirs: { soul: string; data: string }) => void | Promise<void>,
): void | Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'mu-ctx-'))
  const soul = join(root, 'soul')
  const data = join(root, 'data')
  mkdirSync(soul, { recursive: true })
  mkdirSync(join(data, 'memory'), { recursive: true })
  const cleanup = () => rmSync(root, { recursive: true, force: true })
  try {
    const r = fn({ soul, data })
    if (r instanceof Promise) return r.finally(cleanup)
    cleanup()
  } catch (e) {
    cleanup()
    throw e
  }
}

function makeConfig(soul: string, data: string): MuConfig {
  return {
    model: {
      primary: {
        name: 'test',
        format: 'openai',
        base_url: 'http://localhost',
        api_key: 'x',
        model: 'test-model',
      },
    },
    scheduler: {
      min_wake_seconds: 120,
      max_wake_seconds: 3600,
      max_sleep_seconds: 28800,
      cron_fallback_seconds: 900,
      night_min_wake_seconds: 1800,
      night_start_hour: 23,
      night_end_hour: 7,
    },
    agent: {
      max_turns_per_cycle: 10,
      session_timeout_minutes: 30,
    },
    paths: {
      soul,
      data,
      tools: join(data, 'tools'),
    },
  }
}

const msgTrigger: WakeTrigger = {
  type: 'message',
  message: {
    id: 'm1',
    source: 'cli',
    chat_type: 'private',
    sender: { id: 'g', name: '哥哥' },
    content: { type: 'text', text: '在吗' },
    timestamp: 0,
  } as IncomingMessage,
}

test('assemble 产出恰好 3 个 system 块', () =>
  withDirs(async ({ soul, data }) => {
    const a = new ContextAssembler(makeConfig(soul, data))
    const r = await a.assemble(msgTrigger, '在吗')
    assert.equal(r.system.length, 3, 'identity+rules / relations / dynamic 三块')
    for (const b of r.system) assert.equal(b.type, 'text')
  }))

test('块0 = identity + BEHAVIOR_RULES,且唯一带 cache_control:ephemeral', () =>
  withDirs(async ({ soul, data }) => {
    // 写一个可识别的 identity.md,确认它进了块0
    writeFileSync(join(soul, 'identity.md'), '我是沐的身份标记XYZ', 'utf-8')
    const a = new ContextAssembler(makeConfig(soul, data))
    const r = await a.assemble(msgTrigger, '在吗')

    const block0 = r.system[0]!
    assert.deepEqual(block0.cache_control, { type: 'ephemeral' }, '块0 必须标 cache')
    assert.match(block0.text!, /我是沐的身份标记XYZ/, '块0 含 identity')
    // BEHAVIOR_RULES 的稳定锚点
    assert.match(block0.text!, /## 核心准则/, '块0 含 BEHAVIOR_RULES')
    assert.match(block0.text!, /## 主动记忆/, '块0 含行为规则后段')

    // 只有块0 带 cache_control,后两块绝不带(否则记忆一变缓存全失效)
    assert.equal(r.system[1]!.cache_control, undefined, '块1 无 cache')
    assert.equal(r.system[2]!.cache_control, undefined, '块2 无 cache')
    const cached = r.system.filter(b => b.cache_control !== undefined)
    assert.equal(cached.length, 1, '全局只有 1 个 cache 断点')
  }))

test('块1 = relations 事实,不带 cache_control', () =>
  withDirs(async ({ soul, data }) => {
    writeFileSync(
      join(data, 'memory', 'user-facts.md'),
      '哥哥喜欢喝奶茶FACT123',
      'utf-8',
    )
    const a = new ContextAssembler(makeConfig(soul, data))
    const r = await a.assemble(msgTrigger, '在吗')

    const block1 = r.system[1]!
    assert.equal(block1.cache_control, undefined)
    assert.match(block1.text!, /哥哥喜欢喝奶茶FACT123/, '块1 含 user-facts')
    assert.match(block1.text!, /关于用户/, '块1 是 relations 段')
    // relations 不该出现在块0/块2 里(顺序专属)
    assert.doesNotMatch(r.system[0]!.text!, /FACT123/)
    assert.doesNotMatch(r.system[2]!.text!, /FACT123/)
  }))

test('块1 在没有任何事实时退化为占位文案,仍是第二块且无 cache', () =>
  withDirs(async ({ soul, data }) => {
    // 不写 user-facts / commitments
    const a = new ContextAssembler(makeConfig(soul, data))
    const r = await a.assemble(msgTrigger, '在吗')
    const block1 = r.system[1]!
    assert.equal(block1.cache_control, undefined)
    assert.match(block1.text!, /还没有记住关于用户的事实/)
  }))

test('块2 = 动态段:时间锚点 + 当前状态 + 意识流 + 唤醒原因,无 cache', () =>
  withDirs(async ({ soul, data }) => {
    const a = new ContextAssembler(makeConfig(soul, data))
    const r = await a.assemble(msgTrigger, '在吗')

    const block2 = r.system[2]!
    assert.equal(block2.cache_control, undefined)
    assert.match(block2.text!, /\[时间锚点\]/, '动态段以时间锚点开头')
    assert.match(block2.text!, /--- 当前状态 ---/)
    assert.match(block2.text!, /--- 本次唤醒原因 ---/)
    // message 触发 → 唤醒原因含发送者名
    assert.match(block2.text!, /收到哥哥的消息/)
  }))

test('块2 第一行就是时间锚点(formatTrigger 在末尾)', () =>
  withDirs(async ({ soul, data }) => {
    const a = new ContextAssembler(makeConfig(soul, data))
    const r = await a.assemble(msgTrigger, '在吗')
    const lines = r.system[2]!.text!.split('\n')
    assert.match(lines[0]!, /^\[时间锚点\] 现在是 \d{4}年\d{1,2}月\d{1,2}日 \d{2}:\d{2}。/)
  }))

test('不同 trigger 类型只改块2 的唤醒原因文案,不改块结构/cache', () =>
  withDirs(async ({ soul, data }) => {
    const a = new ContextAssembler(makeConfig(soul, data))
    const cases: Array<[WakeTrigger, RegExp]> = [
      [{ type: 'self_scheduled', reason: '想读书', activity_type: 'learning' }, /自己决定醒来: 想读书 \(计划: learning\)/],
      [{ type: 'cron_fallback', reason: '兜底' }, /被 cron 兜底唤醒: 兜底/],
      [{ type: 'system_event', event: '留言板更新' }, /系统事件: 留言板更新/],
      [{ type: 'manual', reason: '手动' }, /手动唤醒: 手动/],
      [{ type: 'webhook', source: 'github', payload: null }, /外部事件: github/],
    ]
    for (const [trig, re] of cases) {
      const r = await a.assemble(trig)
      assert.equal(r.system.length, 3, `${trig.type} 仍是 3 块`)
      assert.deepEqual(r.system[0]!.cache_control, { type: 'ephemeral' })
      assert.equal(r.system[1]!.cache_control, undefined)
      assert.equal(r.system[2]!.cache_control, undefined)
      assert.match(r.system[2]!.text!, re, `${trig.type} 的唤醒原因文案`)
    }
  }))

test('registerTools:assemble.tools 透传注册的工具(默认空数组)', () =>
  withDirs(async ({ soul, data }) => {
    const a = new ContextAssembler(makeConfig(soul, data))
    const r0 = await a.assemble(msgTrigger, '在吗')
    assert.deepEqual(r0.tools, [], '未注册时 tools 为空数组')

    const tools: AnthropicTool[] = [
      { name: 'memory_save', description: 'save', input_schema: { type: 'object' } },
    ]
    a.registerTools(tools)
    const r1 = await a.assemble(msgTrigger, '在吗')
    assert.deepEqual(r1.tools, tools, 'tools 原样透传')
    // 注册工具不影响 system 块结构
    assert.equal(r1.system.length, 3)
  }))

test('无 store 时不注入 episodic(episodicLayer 为 null)', () =>
  withDirs(async ({ soul, data }) => {
    const a = new ContextAssembler(makeConfig(soul, data))
    assert.equal(a.episodicLayer, null, '不传 store → 无 episodic 层')
    const r = await a.assemble(msgTrigger, '在吗')
    // 仍是 3 块(episodic 只是往块2 dynamicParts 里 push,不增块)
    assert.equal(r.system.length, 3)
  }))

test('procedural 技能命中:注入到块2,不新增块', () =>
  withDirs(async ({ soul, data }) => {
    const skillsDir = join(data, 'skills')
    mkdirSync(skillsDir, { recursive: true })
    writeFileSync(
      join(skillsDir, 'comfort.md'),
      '---\nname: 哄哥哥\ntrigger: ["难过"]\n---\n抱抱他SKILLBODY',
      'utf-8',
    )
    const a = new ContextAssembler(makeConfig(soul, data))
    const r = await a.assemble(msgTrigger, '哥哥今天很难过')
    assert.equal(r.system.length, 3, '技能注入不增块')
    assert.match(r.system[2]!.text!, /相关技能/)
    assert.match(r.system[2]!.text!, /SKILLBODY/)
    assert.equal(r.system[2]!.cache_control, undefined, '块2 仍无 cache')
  }))

test('setLastUserContact / setLastWake 进块2 的当前状态,不动块0/块1 cache', () =>
  withDirs(async ({ soul, data }) => {
    const a = new ContextAssembler(makeConfig(soul, data))
    a.setLastUserContact(new Date(Date.now() - 3 * 3600_000))
    a.setLastWake(new Date(Date.now() - 600_000), 'reading')
    const r = await a.assemble(msgTrigger, '在吗')
    assert.match(r.system[2]!.text!, /距上次和用户说话/)
    assert.match(r.system[2]!.text!, /距上次唤醒/)
    assert.match(r.system[2]!.text!, /reading/)
    // cache 标记不受影响
    assert.deepEqual(r.system[0]!.cache_control, { type: 'ephemeral' })
    assert.equal(r.system[2]!.cache_control, undefined)
  }))

test('identity 缺省:无 soul 文件时块0 用 DEFAULT_IDENTITY,仍带 cache', () =>
  withDirs(async ({ soul, data }) => {
    // soul 目录为空(没有 identity/style/values.md)
    const a = new ContextAssembler(makeConfig(soul, data))
    const r = await a.assemble(msgTrigger, '在吗')
    assert.match(r.system[0]!.text!, /你是 Shion/, '退回 DEFAULT_IDENTITY')
    assert.deepEqual(r.system[0]!.cache_control, { type: 'ephemeral' })
  }))

// ── Phase 2: Task 注入(按 trigger 分流,只读 active-tasks.json,放块2 动态段不击穿缓存)──

function mkTask(over: Partial<Task> = {}): Task {
  return {
    id: 'task_t1',
    title: '调研三个向量库',
    dod: '产出对比表',
    status: 'open',
    source: { channel: 'cli', raw: 'r', at: '2026-06-29T00:00:00.000Z' },
    steps: [{ id: 's1', text: '列候选', status: 'todo' }],
    review: [],
    next_step: '先列候选库',
    last_progress: '',
    wake_count: 0,
    fail_streak: 0,
    next_wake_at: null,
    blocked_reason: null,
    created: '2026-06-29',
    updated: '2026-06-29T00:00:00.000Z',
    ...over,
  }
}

function writeTasks(data: string, tasks: Task[], notifiedBlocked: string[] = []): void {
  writeFileSync(
    join(data, 'memory', 'active-tasks.json'),
    JSON.stringify({ tasks, notified_blocked: notifiedBlocked }),
    'utf-8',
  )
}

test('self_scheduled 且 reason 含 task id → 块2 注入该 task 全文', () =>
  withDirs(async ({ soul, data }) => {
    writeTasks(data, [mkTask({ id: 'task_abc', title: '写周报XYZ', next_step: '汇总三个项目PROG' })])
    const a = new ContextAssembler(makeConfig(soul, data))
    const r = await a.assemble({ type: 'self_scheduled', reason: '推进任务 task_abc', activity_type: 'task' })
    assert.equal(r.system.length, 3, '注入不增块')
    const dyn = r.system[2]!.text!
    assert.match(dyn, /当前要推进的任务/)
    assert.match(dyn, /写周报XYZ/, '注入了 title')
    assert.match(dyn, /汇总三个项目PROG/, '注入了 next_step')
    assert.equal(r.system[2]!.cache_control, undefined, '块2 仍无 cache')
    assert.deepEqual(r.system[0]!.cache_control, { type: 'ephemeral' }, 'cache 前缀不变')
  }))

test('self_scheduled 但 reason 不含任何 task id → 不注入 task 全文', () =>
  withDirs(async ({ soul, data }) => {
    writeTasks(data, [mkTask({ id: 'task_abc', title: '写周报XYZ' })])
    const a = new ContextAssembler(makeConfig(soul, data))
    const r = await a.assemble({ type: 'self_scheduled', reason: '随便看看', activity_type: 'rest' })
    assert.doesNotMatch(r.system[2]!.text!, /当前要推进的任务/)
    assert.doesNotMatch(r.system[2]!.text!, /写周报XYZ/)
  }))

test('cron_fallback → 块2 注入全部 open task 一行摘要', () =>
  withDirs(async ({ soul, data }) => {
    writeTasks(data, [
      mkTask({ id: 'task_1', title: '任务一AAA', status: 'open' }),
      mkTask({ id: 'task_2', title: '任务二BBB', status: 'in_progress' }),
      mkTask({ id: 'task_3', title: '已完成CCC', status: 'done' }),
      mkTask({ id: 'task_4', title: '卡住DDD', status: 'blocked', blocked_reason: 'x' }),
    ], ['task_4']) // task_4 已告知用户,不再注入 blocked 提示,本测专测 open 摘要过滤
    const a = new ContextAssembler(makeConfig(soul, data))
    const r = await a.assemble({ type: 'cron_fallback', reason: '兜底' })
    const dyn = r.system[2]!.text!
    assert.match(dyn, /进行中的任务/)
    assert.match(dyn, /任务一AAA/, 'open 进摘要')
    assert.match(dyn, /任务二BBB/, 'in_progress 进摘要')
    assert.doesNotMatch(dyn, /已完成CCC/, 'done 不进摘要')
    assert.doesNotMatch(dyn, /卡住DDD/, 'blocked 不进摘要(且已 notified 不注入提示)')
    assert.equal(r.system.length, 3)
  }))

test('message 触发 → 块2 只注入"你有 N 个进行中任务"一行(不展开)', () =>
  withDirs(async ({ soul, data }) => {
    writeTasks(data, [
      mkTask({ id: 'task_1', title: '细节标题不该出现SECRET', status: 'open' }),
      mkTask({ id: 'task_2', title: '另一个', status: 'in_progress' }),
    ])
    const a = new ContextAssembler(makeConfig(soul, data))
    const r = await a.assemble(msgTrigger, '在吗')
    const dyn = r.system[2]!.text!
    assert.match(dyn, /你有 2 个进行中任务/)
    assert.doesNotMatch(dyn, /SECRET/, 'message 触发不展开 task 详情')
  }))

test('无 open task:三种 trigger 都不注入任何 task 文案(退回纯被动)', () =>
  withDirs(async ({ soul, data }) => {
    // 全是 done/blocked,没有 open/in_progress
    writeTasks(data, [mkTask({ id: 'task_d', status: 'done' }), mkTask({ id: 'task_b', status: 'blocked' })])
    const a = new ContextAssembler(makeConfig(soul, data))
    for (const trig of [
      msgTrigger,
      { type: 'cron_fallback', reason: 'x' } as WakeTrigger,
      { type: 'self_scheduled', reason: '推进任务 task_d', activity_type: 'task' } as WakeTrigger,
    ]) {
      const r = await a.assemble(trig, '在吗')
      const dyn = r.system[2]!.text!
      assert.doesNotMatch(dyn, /进行中的任务/, `${trig.type} 无 open task 不注入摘要`)
      assert.doesNotMatch(dyn, /个进行中任务/, `${trig.type} 无 open task 不注入计数`)
      assert.doesNotMatch(dyn, /当前要推进的任务/, `${trig.type} done 的 task 不注入全文`)
    }
  }))

test('active-tasks.json 不存在:assemble 不崩,块2 无 task 文案', () =>
  withDirs(async ({ soul, data }) => {
    // 不写 active-tasks.json
    const a = new ContextAssembler(makeConfig(soul, data))
    const r = await a.assemble(msgTrigger, '在吗')
    assert.equal(r.system.length, 3)
    assert.doesNotMatch(r.system[2]!.text!, /进行中任务/)
  }))

// ── H2: blocked task 一次性告知用户(notified_blocked 去重)──

test('H2:blocked 且未 notified → 块2 注入"请告知用户"提示,不增块、不击穿 cache', () =>
  withDirs(async ({ soul, data }) => {
    writeTasks(data, [mkTask({ id: 'task_blk', title: '调研XX', status: 'blocked', blocked_reason: '达上限BLKR' })])
    const a = new ContextAssembler(makeConfig(soul, data))
    const r = await a.assemble(msgTrigger, '在吗')
    const dyn = r.system[2]!.text!
    assert.match(dyn, /需要告知用户的挂起任务/)
    assert.match(dyn, /task_blk/)
    assert.match(dyn, /达上限BLKR/, '注入了 blocked_reason')
    assert.match(dyn, /message_send/, '提示用 message_send 告知')
    assert.equal(r.system.length, 3, '注入不增块')
    assert.deepEqual(r.system[0]!.cache_control, { type: 'ephemeral' }, 'cache 前缀不变')
    assert.equal(r.system[2]!.cache_control, undefined, '块2 仍无 cache')
  }))

test('H2:blocked 且已 notified → 不再注入提示(去重)', () =>
  withDirs(async ({ soul, data }) => {
    writeTasks(data, [mkTask({ id: 'task_blk', title: '调研XX', status: 'blocked', blocked_reason: 'x' })], ['task_blk'])
    const a = new ContextAssembler(makeConfig(soul, data))
    const r = await a.assemble(msgTrigger, '在吗')
    assert.doesNotMatch(r.system[2]!.text!, /需要告知用户的挂起任务/, '已 notified 不重复注入')
  }))
