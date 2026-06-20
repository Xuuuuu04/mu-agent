import { test } from 'node:test'
import assert from 'node:assert/strict'
import { guardStyle } from './style-guard.js'

// 锁住专业助理的清理行为:保留 markdown、保留术语,只规整空白。
// (旧版会删 markdown / 翻译术语,改为专业助理后那些行为已移除)

test('保留 markdown(专业助理允许结构化输出)', () => {
  const md = '## 标题\n**重点**是这个\n- 列表项\n`code`'
  const { cleaned } = guardStyle(md)
  assert.ok(cleaned.includes('##'), '标题保留')
  assert.ok(cleaned.includes('**重点**'), '粗体保留')
  assert.ok(cleaned.includes('- 列表项'), '列表保留')
  assert.ok(cleaned.includes('`code`'), '代码保留')
})

test('保留技术术语(不翻译 API/embedding/cache)', () => {
  const { cleaned } = guardStyle('这个 API 用了 embedding 和 cache')
  assert.ok(cleaned.includes('API'))
  assert.ok(cleaned.includes('embedding'))
  assert.ok(cleaned.includes('cache'))
})

test('多余空行折叠 + 首尾 trim', () => {
  const { cleaned } = guardStyle('  开头\n\n\n\n中间\n\n结尾  ')
  assert.ok(!cleaned.includes('\n\n\n'))
  assert.equal(cleaned, cleaned.trim())
})

test('issues 恒为空:不再做删改,只规整空白', () => {
  const { issues } = guardStyle('## 标题 API embedding 综上所述')
  assert.deepEqual(issues, [])
})
