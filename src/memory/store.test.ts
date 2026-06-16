import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from './store.js'

// 用内存 sqlite 建完整 FTS 库,无需 fixture。锁中文子串走 LIKE、%_ 转义、FTS 语法错静默降级、去重
function freshStore(rows: Array<{ id: string; content: string }>): MemoryStore {
  const s = new MemoryStore(':memory:')
  let t = 0
  for (const r of rows) {
    s.insertEpisode({
      id: r.id,
      timestamp: new Date(Date.UTC(2026, 5, 15, 0, 0, t++)).toISOString(),
      source: 'chat', role: 'user', content: r.content,
      summary: null, embedding: null, session_id: 's1', topic_tags: null, entities: null,
    })
  }
  return s
}

test('中文子串走 LIKE 兜底(FTS unicode61 整段切词 MATCH 不到)', () => {
  const s = freshStore([{ id: 'E', content: '我在深圳出差三天' }])
  const ids = s.searchHybrid('深圳').map(r => r.id)
  assert.ok(ids.includes('E'))
  s.close()
})

test('searchLike: % 当字面量转义,不当通配符', () => {
  const s = freshStore([
    { id: 'A', content: '进度 100% 完成' },
    { id: 'B', content: '得分 1000 分' },     // 含 "100" 子串,若 % 不转义会被误命中
  ])
  const ids = s.searchLike('100%').map(r => r.id)
  assert.ok(ids.includes('A'))
  assert.ok(!ids.includes('B'), '% 转义后不应误匹配 1000')
  s.close()
})

test('searchLike: _ 当字面量转义', () => {
  const s = freshStore([
    { id: 'C', content: 'a_b 变量' },
    { id: 'D', content: 'axb 别的' },          // _ 若不转义会当单字符通配匹配
  ])
  const ids = s.searchLike('a_b').map(r => r.id)
  assert.ok(ids.includes('C'))
  assert.ok(!ids.includes('D'), '_ 转义后不应误匹配 axb')
  s.close()
})

test('FTS 语法错(query 带引号)静默降级 LIKE,不抛', () => {
  const s = freshStore([{ id: 'F', content: '含有 a"b 的内容' }])
  assert.doesNotThrow(() => s.searchHybrid('a"b'))
  s.close()
})

test('FTS+LIKE 双命中按 id 去重,不重复', () => {
  const s = freshStore([{ id: 'G', content: 'hello world 你好' }])
  const results = s.searchHybrid('hello')
  assert.equal(results.filter(r => r.id === 'G').length, 1)
  s.close()
})
