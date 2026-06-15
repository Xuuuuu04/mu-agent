import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeSchema } from './openai.js'

// 锁住 GLM function-calling 的 schema 清洗:anyOf/format/const 等会让请求 400(code 1210)
type Obj = Record<string, unknown>

test('剥 anyOf:取第一个非 null 分支,无 anyOf 残留', () => {
  const out = sanitizeSchema({ anyOf: [{ type: 'null' }, { type: 'string' }] }) as Obj
  assert.equal(out.type, 'string')
  assert.ok(!('anyOf' in out))
})

test('剥 oneOf 同理', () => {
  const out = sanitizeSchema({ oneOf: [{ type: 'null' }, { type: 'number' }] }) as Obj
  assert.equal(out.type, 'number')
  assert.ok(!('oneOf' in out))
})

test('allOf:合并所有分支', () => {
  const out = sanitizeSchema({ allOf: [{ type: 'object' }, { description: 'x' }] }) as Obj
  assert.equal(out.type, 'object')
  assert.equal(out.description, 'x')
  assert.ok(!('allOf' in out))
})

test('删 GLM 不认的关键字 format/$ref/$schema/additionalProperties/definitions/patternProperties', () => {
  const out = sanitizeSchema({
    type: 'string', format: 'date-time', $ref: '#/x', $schema: 'http://...',
    additionalProperties: false, definitions: {}, patternProperties: {},
  }) as Obj
  for (const k of ['format', '$ref', '$schema', 'additionalProperties', 'definitions', 'patternProperties']) {
    assert.ok(!(k in out), `${k} 应被删`)
  }
  assert.equal(out.type, 'string')
})

test('property 级非法 required(非数组)删除;object 级 required 数组保留', () => {
  const propLevel = sanitizeSchema({ type: 'string', required: true }) as Obj
  assert.ok(!('required' in propLevel))
  const objLevel = sanitizeSchema({ type: 'object', required: ['a', 'b'] }) as Obj
  assert.deepEqual(objLevel.required, ['a', 'b'])
})

test('const → enum', () => {
  const out = sanitizeSchema({ const: 'fixed' }) as Obj
  assert.deepEqual(out.enum, ['fixed'])
  assert.ok(!('const' in out))
})

test('递归:properties 和 items 内部也被清洗', () => {
  const out = sanitizeSchema({
    type: 'object',
    properties: {
      name: { type: 'string', format: 'email' },
      tags: { type: 'array', items: { anyOf: [{ type: 'null' }, { type: 'string' }] } },
    },
  }) as Obj
  const props = out.properties as Obj
  assert.ok(!('format' in (props.name as Obj)))
  const items = (props.tags as Obj).items as Obj
  assert.equal(items.type, 'string')        // 嵌套 anyOf 也被剥
  assert.ok(!('anyOf' in items))
})

test('非对象输入原样返回', () => {
  assert.equal(sanitizeSchema('str'), 'str')
  assert.equal(sanitizeSchema(null), null)
  assert.equal(sanitizeSchema(42), 42)
})
