import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  memorySaveTool,
  memorySearchTool,
  memoryUpdateTool,
  memoryForgetTool,
} from './facts.js'
import type { ToolContext } from '../../../core/types.js'

// 临时 dataDir,每个测试独立。ctx 最小集:dataDir + log(吞掉)。store 默认不给(三/四路靠文件)。
function withCtx(fn: (ctx: ToolContext, dataDir: string) => void | Promise<void>): void | Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'mu-facts-'))
  const ctx = { dataDir, log: () => {} } as unknown as ToolContext
  const cleanup = () => rmSync(dataDir, { recursive: true, force: true })
  try {
    const r = fn(ctx, dataDir)
    if (r instanceof Promise) return r.finally(cleanup)
    cleanup()
  } catch (e) { cleanup(); throw e }
}

const factsFile = (dataDir: string) => join(dataDir, 'memory', 'user-facts.md')

function writeFacts(dataDir: string, body: string): void {
  const p = factsFile(dataDir)
  mkdirSync(join(dataDir, 'memory'), { recursive: true })
  writeFileSync(p, body, 'utf-8')
}

// ── memory_save ──────────────────────────────────────────────

test('memory_save:写入 [日期] [分类] 内容,文件不存在自动建', () => withCtx(async (ctx, dataDir) => {
  assert.equal(existsSync(factsFile(dataDir)), false)
  const r = await memorySaveTool.execute({ category: 'fact', content: '哥哥喜欢喝美式' }, ctx)
  assert.equal(r.success, true)
  assert.equal(r.output, '记住了')
  const body = readFileSync(factsFile(dataDir), 'utf-8')
  const today = new Date().toISOString().slice(0, 10)
  assert.match(body, new RegExp(`\\[${today}\\] \\[fact\\] 哥哥喜欢喝美式`))
}))

test('memory_save:absolutizeTime 把"明天"固化成绝对日期(不再含"明天")', () => withCtx(async (ctx, dataDir) => {
  await memorySaveTool.execute({ category: 'event', content: '哥哥明天答辩' }, ctx)
  const body = readFileSync(factsFile(dataDir), 'utf-8')
  assert.ok(!body.includes('明天'), '"明天"应被替换掉')
  // absolutize 产出形如 "6月16日(周X)"
  assert.match(body, /\d+月\d+日（?\(?周[日一二三四五六]）?\)?/)
}))

test('memory_save:多次写入累积追加(不覆盖)', () => withCtx(async (ctx, dataDir) => {
  await memorySaveTool.execute({ category: 'fact', content: '第一条' }, ctx)
  await memorySaveTool.execute({ category: 'fact', content: '第二条' }, ctx)
  const body = readFileSync(factsFile(dataDir), 'utf-8')
  assert.ok(body.includes('第一条'))
  assert.ok(body.includes('第二条'))
}))

// ── memory_search ────────────────────────────────────────────

test('memory_search:第一路命中 user-facts,加 [记住的事实] 表头', () => withCtx(async (ctx, dataDir) => {
  writeFacts(dataDir, '[2026-06-15] [fact] 哥哥在深圳工作\n[2026-06-15] [fact] 哥哥养了只猫')
  const r = await memorySearchTool.execute({ query: '深圳' }, ctx)
  assert.equal(r.success, true)
  assert.ok(r.output.includes('[记住的事实]'))
  assert.ok(r.output.includes('深圳'))
}))

test('memory_search:大小写不敏感(query 小写命中大写内容)', () => withCtx(async (ctx, dataDir) => {
  writeFacts(dataDir, '[2026-06-15] [fact] 哥哥的航班是 CZ6309')
  const r = await memorySearchTool.execute({ query: 'cz6309' }, ctx)
  assert.ok(r.output.includes('CZ6309'))
}))

test('memory_search:全空时返回"没找到"文案,success 仍为 true', () => withCtx(async (ctx) => {
  const r = await memorySearchTool.execute({ query: '不存在的词' }, ctx)
  assert.equal(r.success, true)
  assert.ok(r.output.includes('没找到'))
  assert.ok(r.output.includes('不存在的词'))
}))

test('memory_search:有 store 时走第二路 episodes,加 [聊过的话和日记]', () => withCtx(async (ctx, dataDir) => {
  // 注入最小 store stub:只实现 search 用到的三个方法
  const ctx2 = {
    ...ctx,
    store: {
      searchHybrid: (_q: string, _n: number) => [
        { timestamp: '2026-06-10T08:00:00.000Z', role: 'user', content: '哥哥说要去爬山' },
      ],
      searchDailySummaries: (_q: string, _n: number) => [] as Array<{ date: string; summary: string }>,
    },
  } as unknown as ToolContext
  const r = await memorySearchTool.execute({ query: '爬山' }, ctx2)
  assert.ok(r.output.includes('[聊过的话和日记]'))
  assert.ok(r.output.includes('用户:'))   // role=user 显示为"用户"
  assert.ok(r.output.includes('爬山'))
  void dataDir
}))

// ── memory_update ────────────────────────────────────────────

test('memory_update:整串包含命中,改为 [updated] 行', () => withCtx(async (ctx, dataDir) => {
  writeFacts(dataDir, '[2026-06-15] [fact] 哥哥手机号 13800001111')
  const r = await memoryUpdateTool.execute({ old: '13800001111', new: '哥哥手机号 13900002222' }, ctx)
  assert.equal(r.success, true)
  assert.equal(r.output, '改好了')
  const body = readFileSync(factsFile(dataDir), 'utf-8')
  assert.ok(body.includes('[updated]'))
  assert.ok(body.includes('13900002222'))
  assert.ok(!body.includes('13800001111'), '旧号被替掉')
}))

test('memory_update:整串对不上,降级 fuzzyMatchLine 关键词命中', () => withCtx(async (ctx, dataDir) => {
  writeFacts(dataDir, '[2026-06-15] [fact] 哥哥的航班 CZ6309 周五起飞')
  // old 整句不存在,但关键 token CZ6309 能模糊命中
  const r = await memoryUpdateTool.execute({ old: 'CZ6309 改签了', new: '航班改成 CZ6310' }, ctx)
  assert.equal(r.success, true)
  const body = readFileSync(factsFile(dataDir), 'utf-8')
  assert.ok(body.includes('CZ6310'))
  assert.ok(!body.includes('CZ6309'), '原行被整行替换')
}))

test('memory_update:absolutize 作用于 new 内容', () => withCtx(async (ctx, dataDir) => {
  writeFacts(dataDir, '[2026-06-15] [fact] 哥哥的计划待定')
  await memoryUpdateTool.execute({ old: '计划', new: '哥哥明天出发' }, ctx)
  const body = readFileSync(factsFile(dataDir), 'utf-8')
  assert.ok(!body.includes('明天'), 'new 里的"明天"也被固化')
}))

test('memory_update:文件不存在返回 error', () => withCtx(async (ctx) => {
  const r = await memoryUpdateTool.execute({ old: 'x', new: 'y' }, ctx)
  assert.equal(r.success, false)
  assert.equal(r.error, '还没有记忆可更新')
}))

test('memory_update:完全找不到(整串+fuzzy 都不中)返回引导文案', () => withCtx(async (ctx, dataDir) => {
  writeFacts(dataDir, '[2026-06-15] [fact] 哥哥喜欢猫')
  const r = await memoryUpdateTool.execute({ old: '完全无关的飞机火箭', new: 'z' }, ctx)
  assert.equal(r.success, false)
  assert.ok(r.error!.includes('没找到'))
  assert.ok(r.error!.includes('memory_forget'))   // 引导用 forget+save
}))

// ── memory_forget ────────────────────────────────────────────

test('memory_forget:命中 1 条,删除并返回"忘掉了"', () => withCtx(async (ctx, dataDir) => {
  writeFacts(dataDir, '[2026-06-15] [fact] 哥哥喜欢猫\n[2026-06-15] [fact] 哥哥讨厌香菜')
  const r = await memoryForgetTool.execute({ key: '香菜' }, ctx)
  assert.equal(r.success, true)
  assert.equal(r.output, '忘掉了')
  const body = readFileSync(factsFile(dataDir), 'utf-8')
  assert.ok(!body.includes('香菜'))
  assert.ok(body.includes('喜欢猫'), '无关行保留')
}))

test('memory_forget:命中多条拒删(不可逆安全行为),返回 error+预览,文件不变', () => withCtx(async (ctx, dataDir) => {
  const original = '[2026-06-15] [fact] 哥哥喜欢猫\n[2026-06-15] [fact] 哥哥讨厌香菜\n[2026-06-15] [fact] 哥哥住深圳'
  writeFacts(dataDir, original)
  // "哥哥" 命中全部 3 行
  const r = await memoryForgetTool.execute({ key: '哥哥' }, ctx)
  assert.equal(r.success, false)
  assert.ok(r.error!.includes('命中 3 条'))
  assert.ok(r.error!.includes('太宽泛'))
  // 关键:文件没动
  const body = readFileSync(factsFile(dataDir), 'utf-8')
  assert.equal(body, original, '拒删时文件完全不变')
}))

test('memory_forget:一条都不中,success=true 且文案"不用忘",文件不变', () => withCtx(async (ctx, dataDir) => {
  const original = '[2026-06-15] [fact] 哥哥喜欢猫'
  writeFacts(dataDir, original)
  const r = await memoryForgetTool.execute({ key: '火星' }, ctx)
  assert.equal(r.success, true)
  assert.ok(r.output.includes('不用忘'))
  assert.equal(readFileSync(factsFile(dataDir), 'utf-8'), original)
}))

test('memory_forget:文件不存在返回 error', () => withCtx(async (ctx) => {
  const r = await memoryForgetTool.execute({ key: 'x' }, ctx)
  assert.equal(r.success, false)
  assert.equal(r.error, '没有记忆')
}))
