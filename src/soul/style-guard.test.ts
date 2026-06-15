import { test } from 'node:test'
import assert from 'node:assert/strict'
import { guardStyle } from './style-guard.js'

// 锁住发给用户前的风格守卫:去 markdown、技术词替换、翻译腔报告、长度报告
test('去 markdown:标题/粗体/代码/列表', () => {
  const { cleaned } = guardStyle('## 标题\n**重点**是这个\n- 列表项\n`code`')
  assert.ok(!cleaned.includes('##'))
  assert.ok(!cleaned.includes('**'))
  assert.ok(!cleaned.includes('`'))
  assert.ok(cleaned.includes('重点'))
})

test('保留算式星号(香蕉*2、a*b*c 不被当斜体删)', () => {
  const { cleaned } = guardStyle('香蕉*2 还有 a*b*c')
  assert.ok(cleaned.includes('香蕉*2'))
  assert.ok(cleaned.includes('a*b*c'))
})

test('技术词替换为中文', () => {
  const { cleaned, issues } = guardStyle('这个 skill 用了 embedding 和 cache')
  assert.ok(cleaned.includes('功能'))
  assert.ok(cleaned.includes('记忆索引'))
  assert.ok(cleaned.includes('缓存'))
  assert.ok(issues.some(i => i.type === 'tech_term'))
})

test('翻译腔检测:只报告不修改(fixed:false)', () => {
  const { issues } = guardStyle('已成功完成,综上所述就这样')
  const trans = issues.filter(i => i.type === 'translation')
  assert.ok(trans.length >= 1)
  assert.ok(trans.every(i => i.fixed === false))
})

// 诚实锁现状:代码对 >500 字只报 too_long issue,并不截断 cleaned
test('>500 字:报告 too_long 但 cleaned 不截断', () => {
  const long = '啊'.repeat(600)
  const { cleaned, issues } = guardStyle(long)
  assert.ok(issues.some(i => i.type === 'too_long'))
  assert.equal(cleaned.length, 600)   // 没截断 —— 这是当前真实行为
})

test('多余空行折叠 + 首尾 trim', () => {
  const { cleaned } = guardStyle('  开头\n\n\n\n中间\n\n结尾  ')
  assert.ok(!cleaned.includes('\n\n\n'))
  assert.equal(cleaned, cleaned.trim())
})
