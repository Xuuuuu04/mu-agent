import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { log } from './logger.js'

// log 是模块级单例。每个用例用临时 logDir,测完清理。
// 注:console.log/error 会真打到控制台(原行为),这里不去拦,只锁文件落盘。
function withLogDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'mu-log-'))
  try { fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

function todayFile(dir: string): string {
  const today = new Date().toISOString().slice(0, 10)
  return join(dir, `mu-${today}.log`)
}

function lines(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as Record<string, unknown>)
}

test('init: 不存在的 logDir 会被递归创建', () => withLogDir((root) => {
  const dir = join(root, 'a', 'b', 'c')
  assert.equal(existsSync(dir), false)
  log.init(dir)
  assert.equal(existsSync(dir), true)
}))

test('info: 写出按天命名的文件 mu-YYYY-MM-DD.log', () => withLogDir((dir) => {
  log.init(dir)
  log.info('test', 'hello')
  const file = todayFile(dir)
  assert.ok(existsSync(file), '当天日志文件应存在')
  const fname = readdirSync(dir).find(f => /^mu-\d{4}-\d{2}-\d{2}\.log$/.test(f))
  assert.ok(fname, '文件名匹配 mu-日期.log')
}))

test('info: 每行是合法 JSON,含 t/level/scope/msg', () => withLogDir((dir) => {
  log.init(dir)
  log.info('scopeA', 'msgA')
  const rows = lines(todayFile(dir))
  const last = rows[rows.length - 1]!
  assert.equal(last.level, 'info')
  assert.equal(last.scope, 'scopeA')
  assert.equal(last.msg, 'msgA')
  assert.equal(typeof last.t, 'string')
  // t 是 ISO 时间戳
  assert.ok(!Number.isNaN(Date.parse(last.t as string)))
}))

test('info: data 字段被展开进 JSON 行', () => withLogDir((dir) => {
  log.init(dir)
  log.info('s', 'm', { foo: 1, bar: 'x' })
  const rows = lines(todayFile(dir))
  const last = rows[rows.length - 1]!
  assert.equal(last.foo, 1)
  assert.equal(last.bar, 'x')
}))

test('warn / error: level 字段正确', () => withLogDir((dir) => {
  log.init(dir)
  log.warn('s', 'w')
  log.error('s', 'e')
  const rows = lines(todayFile(dir))
  const warnRow = rows.find(r => r.msg === 'w')!
  const errRow = rows.find(r => r.msg === 'e')!
  assert.equal(warnRow.level, 'warn')
  assert.equal(errRow.level, 'error')
}))

test('trace: 只写文件不抛,level 记为 info', () => withLogDir((dir) => {
  log.init(dir)
  assert.doesNotThrow(() => log.trace('tr', 'traced', { k: 9 }))
  const rows = lines(todayFile(dir))
  const last = rows[rows.length - 1]!
  assert.equal(last.level, 'info')
  assert.equal(last.scope, 'tr')
  assert.equal(last.msg, 'traced')
  assert.equal(last.k, 9)
}))

test('多次写入同一天 → 追加到同一文件(多行)', () => withLogDir((dir) => {
  log.init(dir)
  log.info('s', 'one')
  log.info('s', 'two')
  log.trace('s', 'three')
  const rows = lines(todayFile(dir))
  const msgs = rows.map(r => r.msg)
  assert.ok(msgs.includes('one'))
  assert.ok(msgs.includes('two'))
  assert.ok(msgs.includes('three'))
}))

test('未 init 时 trace 是 no-op,不抛', () => {
  // 重置单例到未初始化状态:用一个新临时 dir init,再确认 trace 行为
  // 这里只验证 trace 不抛(无文件目标时直接 return)
  withLogDir((dir) => {
    log.init(dir)
  })
  // init 已发生在上面已删除的 dir,logDir 仍指向已删目录;trace 不应抛
  assert.doesNotThrow(() => log.trace('x', 'y'))
})
