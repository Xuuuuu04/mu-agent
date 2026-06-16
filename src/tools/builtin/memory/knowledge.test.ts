import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { searchKnowledge } from './knowledge.js'

// searchKnowledge 被 memory_search(第四路)和 /memory 命令共用,契约不能漂。
function withKnowledge(files: Record<string, string>, fn: (dataDir: string) => void): void {
  const dataDir = mkdtempSync(join(tmpdir(), 'mu-kn-'))
  const dir = join(dataDir, 'knowledge')
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  try { fn(dataDir) } finally { rmSync(dataDir, { recursive: true, force: true }) }
}

test('标题命中优先于内容命中', () => {
  withKnowledge({
    '张居正.md': '# 张居正\n明代政治家',
    '货币史.md': '白银货币化与张居正一条鞭法',
  }, (d) => {
    const out = searchKnowledge(d, '张居正')
    assert.ok(out[0]!.includes('《张居正》'), '标题命中排第一')
    assert.ok(out.some(l => l.includes('货币史')), '内容命中也在')
  })
})

test('内容命中给出摘录行', () => {
  withKnowledge({ '笔记.md': '第一行\n这里讲到白银货币化\n第三行' }, (d) => {
    const out = searchKnowledge(d, '白银')
    assert.ok(out.some(l => l.includes('白银货币化')))
  })
})

test('无 knowledge 目录返回空数组(不抛)', () => {
  const d = mkdtempSync(join(tmpdir(), 'mu-empty-'))
  try { assert.deepEqual(searchKnowledge(d, 'x'), []) }
  finally { rmSync(d, { recursive: true, force: true }) }
})

test('结果上限 5 条', () => {
  const files: Record<string, string> = {}
  for (let i = 0; i < 10; i++) files[`主题${i}.md`] = '正文'
  withKnowledge(files, (d) => {
    assert.ok(searchKnowledge(d, '主题').length <= 5)
  })
})
