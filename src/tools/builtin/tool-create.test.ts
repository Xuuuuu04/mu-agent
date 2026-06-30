import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { toolCreateTool } from './tool-create.js'
import type { ToolContext } from '../../core/types.js'

function withCtx(fn: (dataDir: string, ctx: ToolContext, logs: string[]) => void | Promise<void>): void | Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'mu-toolcreate-'))
  const logs: string[] = []
  const ctx = { dataDir, log: (m: string) => logs.push(m) } as unknown as ToolContext
  const cleanup = () => rmSync(dataDir, { recursive: true, force: true })
  try {
    const r = fn(dataDir, ctx, logs)
    if (r instanceof Promise) return r.finally(cleanup)
    cleanup()
  } catch (e) { cleanup(); throw e }
}

function readJSON(dataDir: string, name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dataDir, 'tools', `${name}.json`), 'utf-8'))
}

test('tool_create:shell 类型写出 {name,description,parameters,command}', () => withCtx(async (dataDir, ctx, logs) => {
  const params = {
    name: 'ring-bell',
    description: '响铃',
    tool_type: 'shell',
    command_or_url: 'play {{sound}}',
    parameters: { sound: { type: 'string', description: '声音文件' } },
  }
  const r = await toolCreateTool.execute(params, ctx)
  assert.equal(r.success, true)
  assert.match(r.output, /创建成功/)

  const def = readJSON(dataDir, 'ring-bell')
  assert.deepEqual(def, {
    name: 'ring-bell',
    description: '响铃',
    parameters: { sound: { type: 'string', description: '声音文件' } },
    command: 'play {{sound}}',
  })
  // shell 类型不应有 url/method 字段
  assert.equal('url' in def, false)
  assert.equal('method' in def, false)
  // ctx.log 被调用
  assert.ok(logs.some(l => l.includes('创建了工具: ring-bell (shell)')))
}))

test('tool_create:http 类型写出 url + method(给了 http_method 用给的)', () => withCtx(async (dataDir, ctx) => {
  const r = await toolCreateTool.execute({
    name: 'weather',
    description: '查天气',
    tool_type: 'http',
    command_or_url: 'https://api/{{city}}',
    parameters: { city: { type: 'string', description: '城市' } },
    http_method: 'POST',
  }, ctx)
  assert.equal(r.success, true)
  const def = readJSON(dataDir, 'weather')
  assert.equal(def.url, 'https://api/{{city}}')
  assert.equal(def.method, 'POST')
  assert.equal('command' in def, false)
}))

test('tool_create:http 类型缺 http_method → 默认 GET', () => withCtx(async (dataDir, ctx) => {
  await toolCreateTool.execute({
    name: 'getthing',
    description: 'd',
    tool_type: 'http',
    command_or_url: 'https://api/x',
    parameters: {},
  }, ctx)
  assert.equal(readJSON(dataDir, 'getthing').method, 'GET')
}))

test('tool_create:未知 tool_type → error,且不落盘', () => withCtx(async (dataDir, ctx) => {
  const r = await toolCreateTool.execute({
    name: 'bad',
    description: 'd',
    tool_type: 'graphql',
    command_or_url: 'x',
    parameters: {},
  }, ctx)
  assert.equal(r.success, false)
  assert.match(r.error!, /未知类型: graphql/)
  assert.equal(existsSync(join(dataDir, 'tools', 'bad.json')), false)
}))

test('tool_create:非法工具名(含 ../)被拒,不写盘', () => withCtx(async (dataDir, ctx) => {
  const r = await toolCreateTool.execute({
    name: '../evil',
    description: 'd',
    tool_type: 'shell',
    command_or_url: 'x',
    parameters: {},
  }, ctx)
  assert.equal(r.success, false)
  assert.match(r.error!, /工具名只能是小写字母开头/)
  // tools 目录可能根本没建
  assert.equal(existsSync(join(dataDir, 'tools', '..', 'evil.json')), false)
}))

test('tool_create:大写/下划线/数字开头都非法', () => withCtx(async (_d, ctx) => {
  for (const name of ['Foo', 'foo_bar', '1foo', 'foo bar', '']) {
    const r = await toolCreateTool.execute({
      name, description: 'd', tool_type: 'shell', command_or_url: 'x', parameters: {},
    }, ctx)
    assert.equal(r.success, false, `${JSON.stringify(name)} 应被拒`)
    assert.match(r.error!, /工具名只能是小写字母开头/)
  }
}))

test('tool_create:合法名带连字符和数字 + 边界长度', () => withCtx(async (dataDir, ctx) => {
  // 正则 ^[a-z][a-z0-9-]{0,40}$ → 首字母 + 最多 40 = 最长 41 字符
  const ok = 'a' + 'b'.repeat(40) // 41 字符
  const r = await toolCreateTool.execute({
    name: ok, description: 'd', tool_type: 'shell', command_or_url: 'x', parameters: {},
  }, ctx)
  assert.equal(r.success, true)
  assert.ok(existsSync(join(dataDir, 'tools', `${ok}.json`)))

  // 42 字符超界被拒
  const tooLong = 'a' + 'b'.repeat(41)
  const r2 = await toolCreateTool.execute({
    name: tooLong, description: 'd', tool_type: 'shell', command_or_url: 'x', parameters: {},
  }, ctx)
  assert.equal(r2.success, false)
}))

test('tool_create:同名工具已存在 → 拒绝,不覆盖原文件', () => withCtx(async (dataDir, ctx) => {
  mkdirSync(join(dataDir, 'tools'), { recursive: true })
  writeFileSync(join(dataDir, 'tools', 'dup.json'), '原始内容', 'utf-8')
  const r = await toolCreateTool.execute({
    name: 'dup', description: 'd', tool_type: 'shell', command_or_url: 'x', parameters: {},
  }, ctx)
  assert.equal(r.success, false)
  assert.match(r.error!, /已存在/)
  // 原文件没被动
  assert.equal(readFileSync(join(dataDir, 'tools', 'dup.json'), 'utf-8'), '原始内容')
}))

test('tool_create:自动建 tools 目录(原本不存在)', () => withCtx(async (dataDir, ctx) => {
  assert.equal(existsSync(join(dataDir, 'tools')), false)
  await toolCreateTool.execute({
    name: 'first', description: 'd', tool_type: 'shell', command_or_url: 'x', parameters: {},
  }, ctx)
  assert.ok(existsSync(join(dataDir, 'tools', 'first.json')))
}))

test('tool_create:JSON 缩进 2 空格', () => withCtx(async (dataDir, ctx) => {
  await toolCreateTool.execute({
    name: 'fmt', description: 'd', tool_type: 'shell', command_or_url: 'x', parameters: {},
  }, ctx)
  const raw = readFileSync(join(dataDir, 'tools', 'fmt.json'), 'utf-8')
  assert.match(raw, /\n {2}"name":/)
}))
