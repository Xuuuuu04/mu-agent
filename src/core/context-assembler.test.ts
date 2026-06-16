import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ContextAssembler } from './context-assembler.js'
import type { MuConfig, WakeTrigger, AnthropicTool, IncomingMessage } from './types.js'

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
    // BEHAVIOR_RULES 的稳定锚点(绝对规则段)
    assert.match(block0.text!, /## 绝对规则/, '块0 含 BEHAVIOR_RULES')
    assert.match(block0.text!, /## 自决唤醒/, '块0 含行为规则后段')

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
    assert.match(block1.text!, /关于哥哥/, '块1 是 relations 段')
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
    assert.match(block1.text!, /还没有记住关于哥哥的事实/)
  }))

test('块2 = 动态段:时间锚点 + 当前状态 + 意识流 + 唤醒原因,无 cache', () =>
  withDirs(async ({ soul, data }) => {
    const a = new ContextAssembler(makeConfig(soul, data))
    const r = await a.assemble(msgTrigger, '在吗')

    const block2 = r.system[2]!
    assert.equal(block2.cache_control, undefined)
    assert.match(block2.text!, /\[时间锚点\]/, '动态段以时间锚点开头')
    assert.match(block2.text!, /--- 当前状态 ---/)
    assert.match(block2.text!, /--- 意识流/)
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
    assert.match(r.system[2]!.text!, /距上次和哥哥说话/)
    assert.match(r.system[2]!.text!, /距上次自己醒来/)
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
    assert.match(r.system[0]!.text!, /你是沐/, '退回 DEFAULT_IDENTITY')
    assert.deepEqual(r.system[0]!.cache_control, { type: 'ephemeral' })
  }))
