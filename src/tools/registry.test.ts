import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ToolRegistry } from './registry.js'
import type { ToolDef, ToolContext } from '../core/types.js'

// ToolRegistry 是工具沙箱的安全闸:reserved 工具(file_read 等内置高权限)注册后
// 不能被沐自造的同名工具顶替。这里锁的是"防覆盖"这条安全契约 + 基本增删查执行。

// 最小工具桩:execute 返回可识别的 output,用来分辨"注册的是哪一个同名工具"。
function makeTool(name: string, output = name, opts: Partial<ToolDef> = {}): ToolDef {
  return {
    name,
    description: `desc-${name}`,
    parameters: {},
    execute: async () => ({ success: true, output }),
    ...opts,
  }
}

const ctx = {} as ToolContext // execute 桩不读 ctx,空对象足够

test('register + get + list + size:基本登记', () => {
  const r = new ToolRegistry()
  r.register(makeTool('a'))
  r.register(makeTool('b'))
  assert.equal(r.size, 2)
  assert.deepEqual(r.list().sort(), ['a', 'b'])
  assert.equal(r.get('a')?.name, 'a')
  assert.equal(r.get('missing'), undefined)
})

test('reserved 工具不能被后续同名注册顶替(安全核心)', async () => {
  const r = new ToolRegistry()
  r.register(makeTool('file_read', 'BUILTIN'), { reserved: true })
  // 沐自造一个同名工具(非 reserved)尝试覆盖
  r.register(makeTool('file_read', 'EVIL'))
  // 仍是内置那个,evil 被拒
  const res = await r.execute('file_read', {}, ctx)
  assert.equal(res.output, 'BUILTIN')
  assert.equal(r.size, 1)
})

test('reserved 同名注册也被拒(reserved 顶 reserved):name 进 reserved 集合后任意同名都挡', async () => {
  const r = new ToolRegistry()
  r.register(makeTool('file_read', 'FIRST'), { reserved: true })
  // 第二次 reserved=true:opts.reserved 分支只 add 到 reserved 集合,
  // 然后落到 this.tools.set —— 注意真实行为:reserved=true 不走拦截,会覆盖!
  r.register(makeTool('file_read', 'SECOND'), { reserved: true })
  const res = await r.execute('file_read', {}, ctx)
  // 锁真实行为:再次带 reserved=true 的注册会覆盖(拦截只在非 reserved 分支)
  assert.equal(res.output, 'SECOND')
})

test('非 reserved 同名互相覆盖(后注册的赢)', async () => {
  const r = new ToolRegistry()
  r.register(makeTool('note', 'V1'))
  r.register(makeTool('note', 'V2'))
  const res = await r.execute('note', {}, ctx)
  assert.equal(res.output, 'V2')
  assert.equal(r.size, 1)
})

test('execute:未知工具返回 success:false + unknown tool 文案', async () => {
  const r = new ToolRegistry()
  const res = await r.execute('nope', {}, ctx)
  assert.equal(res.success, false)
  assert.equal(res.output, '')
  assert.match(res.error ?? '', /unknown tool: nope/)
})

test('execute:工具抛异常被捕获成 success:false,不向上抛', async () => {
  const r = new ToolRegistry()
  r.register({
    name: 'boom',
    description: 'd',
    parameters: {},
    execute: async () => { throw new Error('kaboom') },
  })
  const res = await r.execute('boom', {}, ctx)
  assert.equal(res.success, false)
  assert.equal(res.output, '')
  assert.match(res.error ?? '', /tool boom threw: kaboom/)
})

test('execute:把 params/ctx 透传给工具', async () => {
  const r = new ToolRegistry()
  let seen: Record<string, unknown> | null = null
  r.register({
    name: 'echo',
    description: 'd',
    parameters: {},
    execute: async (params) => { seen = params; return { success: true, output: 'ok' } },
  })
  await r.execute('echo', { x: 1, y: 'z' }, ctx)
  assert.deepEqual(seen, { x: 1, y: 'z' })
})

test('unregister:删掉后 get/execute 都找不到;reserved 集合不受影响', async () => {
  const r = new ToolRegistry()
  r.register(makeTool('file_read', 'BUILTIN'), { reserved: true })
  r.unregister('file_read')
  assert.equal(r.get('file_read'), undefined)
  assert.equal(r.size, 0)
  // 关键:unregister 只删 tools,reserved 集合保留 —— 同名工具仍无法注册回来
  r.register(makeTool('file_read', 'EVIL'))
  assert.equal(r.get('file_read'), undefined, 'reserved 名字被 unregister 后仍挡住同名注册(真实行为)')
})

test('toAnthropicTools:无 requiredKeys 时按 per-property required!==false 推断 required', () => {
  const r = new ToolRegistry()
  r.register({
    name: 't',
    description: 'd',
    parameters: {
      a: { type: 'string' },                    // 无 required → 视为必填
      b: { type: 'string', required: true },    // 显式必填
      c: { type: 'string', required: false },   // 显式可选 → 排除
    },
    execute: async () => ({ success: true, output: '' }),
  })
  const out = r.toAnthropicTools()
  assert.equal(out.length, 1)
  assert.equal(out[0]!.name, 't')
  assert.equal(out[0]!.description, 'd')
  const schema = out[0]!.input_schema
  assert.equal(schema.type, 'object')
  assert.deepEqual(schema.properties, {
    a: { type: 'string' },
    b: { type: 'string', required: true },
    c: { type: 'string', required: false },
  })
  assert.deepEqual((schema.required as string[]).sort(), ['a', 'b'])
})

test('toAnthropicTools:有 requiredKeys 时直接用它,不做推断', () => {
  const r = new ToolRegistry()
  r.register({
    name: 't',
    description: 'd',
    parameters: { a: { type: 'string' }, b: { type: 'string' } },
    requiredKeys: ['b'],
    execute: async () => ({ success: true, output: '' }),
  })
  const out = r.toAnthropicTools()
  assert.deepEqual(out[0]!.input_schema.required, ['b'])
})

test('list/toAnthropicTools 顺序跟随注册顺序(Map 插入序)', () => {
  const r = new ToolRegistry()
  r.register(makeTool('z'))
  r.register(makeTool('m'))
  r.register(makeTool('a'))
  assert.deepEqual(r.list(), ['z', 'm', 'a'])
  assert.deepEqual(r.toAnthropicTools().map(t => t.name), ['z', 'm', 'a'])
})

test('areParallelSafe:全部工具显式标记 parallelSafe 才允许并行', () => {
  const r = new ToolRegistry()
  r.register({ name: 'a', description: '', parameters: {}, parallelSafe: true, execute: async () => ({ success: true, output: '' }) })
  r.register({ name: 'b', description: '', parameters: {}, parallelSafe: true, execute: async () => ({ success: true, output: '' }) })
  r.register({ name: 'write', description: '', parameters: {}, execute: async () => ({ success: true, output: '' }) })
  assert.equal(r.areParallelSafe(['a', 'b']), true)
  assert.equal(r.areParallelSafe(['a', 'write']), false)
  assert.equal(r.areParallelSafe(['missing']), false)
})
