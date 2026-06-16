import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileReadTool, fileWriteTool, fileListTool, resolveSafe } from './file.js'

// ── resolveSafe(纯函数,导出)──
test('resolveSafe: 剥开头多余的 data/ 前缀', () => {
  assert.equal(resolveSafe('/d', 'data/x.txt'), join('/d', 'x.txt'))
  assert.equal(resolveSafe('/d', './data/x.txt'), join('/d', 'x.txt'))
  assert.equal(resolveSafe('/d', '/data/x.txt'), join('/d', 'x.txt'))
})
test('resolveSafe: 普通路径和 data.txt 文件名不受影响', () => {
  assert.equal(resolveSafe('/d', 'notes/a.md'), join('/d', 'notes/a.md'))
  assert.equal(resolveSafe('/d', 'data.txt'), join('/d', 'data.txt'))
})
test('resolveSafe: 逃逸仍被挡(剥 data/ 后 ../ 也拦)', () => {
  assert.equal(resolveSafe('/d', '../etc/passwd'), null)
  assert.equal(resolveSafe('/d', 'data/../../etc'), null)
  assert.equal(resolveSafe('/d', '../d-backup/x'), null)   // 同前缀兄弟目录
})
import type { ToolContext } from '../../core/types.js'

// 临时 dataDir + 最小 ctx。只锁 file_read/write/list 真实行为。
function withDataDir(fn: (dataDir: string, ctx: ToolContext) => void | Promise<void>): void | Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'mu-file-'))
  const ctx = { dataDir, log: () => {} } as unknown as ToolContext
  const cleanup = () => rmSync(dataDir, { recursive: true, force: true })
  try {
    const r = fn(dataDir, ctx)
    if (r instanceof Promise) return r.finally(cleanup)
    cleanup()
  } catch (e) { cleanup(); throw e }
}

// ---------- file_read ----------

test('file_read:读出已有文件内容', () => withDataDir(async (dataDir, ctx) => {
  writeFileSync(join(dataDir, 'a.txt'), '哥哥好', 'utf-8')
  const r = await fileReadTool.execute({ path: 'a.txt' }, ctx)
  assert.equal(r.success, true)
  assert.equal(r.output, '哥哥好')
  assert.equal(r.error, undefined)
}))

test('file_read:文件不存在 → success=false / error=文件不存在', () => withDataDir(async (_d, ctx) => {
  const r = await fileReadTool.execute({ path: 'nope.txt' }, ctx)
  assert.equal(r.success, false)
  assert.equal(r.output, '')
  assert.equal(r.error, '文件不存在')
}))

test('file_read:目录逃逸 ../ → 路径不允许(不到达 existsSync)', () => withDataDir(async (_d, ctx) => {
  const r = await fileReadTool.execute({ path: '../escape.txt' }, ctx)
  assert.equal(r.success, false)
  assert.equal(r.error, '路径不允许')
}))

test('file_read:>100KB 文件被拒(文件太大)', () => withDataDir(async (dataDir, ctx) => {
  writeFileSync(join(dataDir, 'big.txt'), 'x'.repeat(100_001), 'utf-8')
  const r = await fileReadTool.execute({ path: 'big.txt' }, ctx)
  assert.equal(r.success, false)
  assert.equal(r.error, '文件太大(>100KB)')
}))

test('file_read:刚好 100KB(边界,不算太大)能读', () => withDataDir(async (dataDir, ctx) => {
  // 阈值是 > 100_000,等于 100_000 放行(ASCII 1 字节/字符)
  writeFileSync(join(dataDir, 'edge.txt'), 'y'.repeat(100_000), 'utf-8')
  const r = await fileReadTool.execute({ path: 'edge.txt' }, ctx)
  assert.equal(r.success, true)
  assert.equal(r.output.length, 100_000)
}))

// ---------- file_write ----------

test('file_write:写文件并自动建父目录', () => withDataDir(async (dataDir, ctx) => {
  const r = await fileWriteTool.execute({ path: 'sub/deep/note.txt', content: '内容' }, ctx)
  assert.equal(r.success, true)
  const target = join(dataDir, 'sub', 'deep', 'note.txt')
  assert.ok(existsSync(target))
  assert.equal(readFileSync(target, 'utf-8'), '内容')
  // output 回的是解析后的绝对路径
  assert.match(r.output, /写入了 .*note\.txt$/)
  assert.ok(r.output.includes(target))
}))

test('file_write:覆盖已存在文件', () => withDataDir(async (dataDir, ctx) => {
  writeFileSync(join(dataDir, 'o.txt'), '旧', 'utf-8')
  const r = await fileWriteTool.execute({ path: 'o.txt', content: '新' }, ctx)
  assert.equal(r.success, true)
  assert.equal(readFileSync(join(dataDir, 'o.txt'), 'utf-8'), '新')
}))

test('file_write:内容 >500KB 被拒(内容太大)', () => withDataDir(async (dataDir, ctx) => {
  const r = await fileWriteTool.execute({ path: 'x.txt', content: 'z'.repeat(500_001) }, ctx)
  assert.equal(r.success, false)
  assert.equal(r.error, '内容太大(>500KB)')
  // 被拒时不落盘
  assert.equal(existsSync(join(dataDir, 'x.txt')), false)
}))

test('file_write:目录逃逸 → 路径不允许(不写盘)', () => withDataDir(async (dataDir, ctx) => {
  const r = await fileWriteTool.execute({ path: '../evil.txt', content: 'x' }, ctx)
  assert.equal(r.success, false)
  assert.equal(r.error, '路径不允许')
}))

test('file_write:剥掉多余的 data/ 前缀,不再双重嵌套(修了 CLAUDE.md 记录的坑)', () => withDataDir(async (dataDir, ctx) => {
  const r = await fileWriteTool.execute({ path: 'data/foo.txt', content: 'hi' }, ctx)
  assert.equal(r.success, true)
  assert.ok(existsSync(join(dataDir, 'foo.txt')), '落在根,不再嵌套进 data/')
  assert.equal(existsSync(join(dataDir, 'data', 'foo.txt')), false, '没有 data/data 双重嵌套')
}))

test('file_write:data.txt 这种文件名不被误剥(只剥 data/ 带斜杠的)', () => withDataDir(async (dataDir, ctx) => {
  await fileWriteTool.execute({ path: 'data.txt', content: 'x' }, ctx)
  assert.ok(existsSync(join(dataDir, 'data.txt')), 'data.txt 文件名保留')
}))

test('file_write:前导斜杠路径不当绝对路径,被 join 拼回 dataDir 下', () => withDataDir(async (dataDir, ctx) => {
  // join(base, '/abs/p') 不逃逸,落在 base 内
  const r = await fileWriteTool.execute({ path: '/abs/p.txt', content: 'k' }, ctx)
  assert.equal(r.success, true)
  assert.ok(existsSync(join(dataDir, 'abs', 'p.txt')))
}))

// ---------- file_list ----------

test('file_list:列出目录,目录名带 / 后缀', () => withDataDir(async (dataDir, ctx) => {
  writeFileSync(join(dataDir, 'f1.txt'), 'a', 'utf-8')
  mkdirSync(join(dataDir, 'subdir'))
  const r = await fileListTool.execute({ path: '.' }, ctx)
  assert.equal(r.success, true)
  const lines = r.output.split('\n').sort()
  assert.deepEqual(lines, ['f1.txt', 'subdir/'])
}))

test('file_list:无 path 参数默认列根目录(. )', () => withDataDir(async (dataDir, ctx) => {
  writeFileSync(join(dataDir, 'only.txt'), 'a', 'utf-8')
  const r = await fileListTool.execute({}, ctx)
  assert.equal(r.success, true)
  assert.equal(r.output, 'only.txt')
}))

test('file_list:空目录 → (空目录)', () => withDataDir(async (dataDir, ctx) => {
  mkdirSync(join(dataDir, 'empty'))
  const r = await fileListTool.execute({ path: 'empty' }, ctx)
  assert.equal(r.success, true)
  assert.equal(r.output, '(空目录)')
}))

test('file_list:目录不存在 → 目录不存在', () => withDataDir(async (_d, ctx) => {
  const r = await fileListTool.execute({ path: 'ghost' }, ctx)
  assert.equal(r.success, false)
  assert.equal(r.error, '目录不存在')
}))

test('file_list:目录逃逸 → 路径不允许', () => withDataDir(async (_d, ctx) => {
  const r = await fileListTool.execute({ path: '..' }, ctx)
  assert.equal(r.success, false)
  assert.equal(r.error, '路径不允许')
}))
