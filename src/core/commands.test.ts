import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isCommandText, tryCommand, type CommandDeps } from './commands.js'
import { MemoryStore } from '../memory/store.js'
import type { Scheduler } from './scheduler.js'

// 最小 scheduler 桩:只实现 getStatus(commands 只用这一个方法)。
// 用 as unknown as Scheduler 绕过其余方法,锁的是 commands 实际调用面。
function fakeScheduler(status: ReturnType<Scheduler['getStatus']>): Scheduler {
  return { getStatus: () => status } as unknown as Scheduler
}

// deps 工厂:dataDir 临时、store :memory:、scheduler 桩、clearSession 计数桩。
// 返回 deps + 清理钩子 + clearSession 调用计数。
function makeDeps(opts?: {
  status?: ReturnType<Scheduler['getStatus']>
  uptime?: number
}): { deps: CommandDeps; cleanup: () => void; clearCalls: () => number; dataDir: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'mu-cmd-'))
  const store = new MemoryStore(':memory:')
  let clears = 0
  const deps: CommandDeps = {
    dataDir,
    store,
    scheduler: fakeScheduler(opts?.status ?? { sleeping: false, nextWake: null, reason: '' }),
    clearSession: () => { clears++ },
    uptimeSeconds: () => opts?.uptime ?? 0,
  }
  return {
    deps,
    cleanup: () => { store.close(); rmSync(dataDir, { recursive: true, force: true }) },
    clearCalls: () => clears,
    dataDir,
  }
}

// ---- isCommandText ----

test('isCommandText: / 开头是命令', () => {
  assert.equal(isCommandText('/status'), true)
})

test('isCommandText: 全角／开头也认', () => {
  assert.equal(isCommandText('／new'), true)
})

test('isCommandText: 前导空格 trim 后判断', () => {
  assert.equal(isCommandText('   /help'), true)
})

test('isCommandText: 普通文本不是命令', () => {
  assert.equal(isCommandText('在吗'), false)
})

test('isCommandText: 空串/全空白不是命令', () => {
  assert.equal(isCommandText(''), false)
  assert.equal(isCommandText('   '), false)
})

// ---- tryCommand 非命令 → null ----

test('tryCommand: 非命令返回 null', () => {
  const { deps, cleanup } = makeDeps()
  try {
    assert.equal(tryCommand('你好呀', deps), null)
  } finally { cleanup() }
})

test('tryCommand: 空白文本返回 null', () => {
  const { deps, cleanup } = makeDeps()
  try {
    assert.equal(tryCommand('   ', deps), null)
  } finally { cleanup() }
})

// ---- /help ----

test('tryCommand: /help 返回帮助文本(列出命令)', () => {
  const { deps, cleanup } = makeDeps()
  try {
    const out = tryCommand('/help', deps)
    assert.ok(out !== null)
    assert.match(out!, /可用命令/)
    assert.match(out!, /\/new/)
    assert.match(out!, /\/status/)
    assert.match(out!, /\/memory/)
  } finally { cleanup() }
})

test('tryCommand: /? 是 help 别名', () => {
  const { deps, cleanup } = makeDeps()
  try {
    assert.equal(tryCommand('/?', deps), tryCommand('/help', deps))
  } finally { cleanup() }
})

// ---- /new + /clear → clearSession ----

test('tryCommand: /new 调 clearSession 一次并返回清空提示', () => {
  const { deps, cleanup, clearCalls } = makeDeps()
  try {
    const out = tryCommand('/new', deps)
    assert.equal(clearCalls(), 1)
    assert.match(out!, /清空|重新开始/)
  } finally { cleanup() }
})

test('tryCommand: /clear 是 new 别名,也调 clearSession', () => {
  const { deps, cleanup, clearCalls } = makeDeps()
  try {
    tryCommand('/clear', deps)
    assert.equal(clearCalls(), 1)
  } finally { cleanup() }
})

test('tryCommand: 全角／new 也触发 clearSession', () => {
  const { deps, cleanup, clearCalls } = makeDeps()
  try {
    tryCommand('／new', deps)
    assert.equal(clearCalls(), 1)
  } finally { cleanup() }
})

test('tryCommand: 命令大小写不敏感(/NEW)', () => {
  const { deps, cleanup, clearCalls } = makeDeps()
  try {
    tryCommand('/NEW', deps)
    assert.equal(clearCalls(), 1)
  } finally { cleanup() }
})

// ---- 未知命令 ----

test('tryCommand: 未知命令返回提示,不调 clearSession', () => {
  const { deps, cleanup, clearCalls } = makeDeps()
  try {
    const out = tryCommand('/nope', deps)
    assert.match(out!, /未知命令/)
    assert.equal(clearCalls(), 0)
  } finally { cleanup() }
})

test('tryCommand: /approve-shell 走零 token 真人批准入口', () => {
  const { deps, cleanup } = makeDeps()
  try {
    const r = tryCommand('/approve-shell missing', deps)
    assert.match(r ?? '', /不存在或已过期/)
  } finally { cleanup() }
})

test('tryCommand: /reject-shell 可拒绝待执行命令', () => {
  const { deps, cleanup } = makeDeps()
  try {
    const r = tryCommand('/reject-shell missing', deps)
    assert.match(r ?? '', /不存在或已过期/)
  } finally { cleanup() }
})

// ---- /status ----

test('tryCommand: /status 空数据时给默认 calm + 记忆条数', () => {
  const { deps, cleanup } = makeDeps({ uptime: 0 })
  try {
    const out = tryCommand('/status', deps)
    assert.match(out!, /心情: calm/)
    assert.match(out!, /记忆: 0 条/)
  } finally { cleanup() }
})

test('tryCommand: /status 读 mood.json 显示心情', () => {
  const { deps, cleanup, dataDir } = makeDeps()
  try {
    mkdirSync(join(dataDir, 'memory'), { recursive: true })
    writeFileSync(join(dataDir, 'memory', 'mood.json'), JSON.stringify({
      current: 'excited', since: new Date().toISOString(), reason: '哥哥回来了',
    }))
    const out = tryCommand('/status', deps)
    assert.match(out!, /心情: excited — 哥哥回来了/)
  } finally { cleanup() }
})

test('tryCommand: /status 睡眠中显示下次自己醒', () => {
  const { deps, cleanup } = makeDeps({
    status: { sleeping: true, nextWake: new Date(Date.now() + 600_000), reason: '写日记' },
  })
  try {
    const out = tryCommand('/status', deps)
    assert.match(out!, /下次自己醒/)
    assert.match(out!, /写日记/)
  } finally { cleanup() }
})

test('tryCommand: /s 是 status 别名', () => {
  const { deps, cleanup } = makeDeps()
  try {
    assert.match(tryCommand('/s', deps)!, /心情:/)
  } finally { cleanup() }
})

// ---- /mood ----

test('tryCommand: /mood 无 mood.json 返回平静兜底', () => {
  const { deps, cleanup } = makeDeps()
  try {
    assert.match(tryCommand('/mood', deps)!, /平静|calm/)
  } finally { cleanup() }
})

test('tryCommand: /mood 有数据显示当前情绪和原因', () => {
  const { deps, cleanup, dataDir } = makeDeps()
  try {
    mkdirSync(join(dataDir, 'memory'), { recursive: true })
    writeFileSync(join(dataDir, 'memory', 'mood.json'), JSON.stringify({
      current: 'missing', since: new Date().toISOString(), reason: '想哥哥了',
      previous: { mood: 'calm', changed_at: new Date().toISOString() },
    }))
    const out = tryCommand('/mood', deps)
    assert.match(out!, /missing/)
    assert.match(out!, /想哥哥了/)
    assert.match(out!, /之前是 calm/)
  } finally { cleanup() }
})

// ---- /todo ----

test('tryCommand: /todo 无承诺返回空提示', () => {
  const { deps, cleanup } = makeDeps()
  try {
    assert.match(tryCommand('/todo', deps)!, /没有待办/)
  } finally { cleanup() }
})

test('tryCommand: /todo 只列 active 承诺,过滤 done', () => {
  const { deps, cleanup, dataDir } = makeDeps()
  try {
    mkdirSync(join(dataDir, 'memory'), { recursive: true })
    writeFileSync(join(dataDir, 'memory', 'commitments.json'), JSON.stringify([
      { id: '1', content: '帮哥哥查机票', type: 'one-time', status: 'active', created: '2026-06-15' },
      { id: '2', content: '已经做完的事', type: 'one-time', status: 'done', created: '2026-06-10' },
    ]))
    const out = tryCommand('/todo', deps)
    assert.match(out!, /帮哥哥查机票/)
    assert.ok(!out!.includes('已经做完的事'), 'done 状态不该出现')
  } finally { cleanup() }
})

test('tryCommand: /commitments 是 todo 别名', () => {
  const { deps, cleanup } = makeDeps()
  try {
    assert.equal(tryCommand('/commitments', deps), tryCommand('/todo', deps))
  } finally { cleanup() }
})

// ---- /memory ----

test('tryCommand: /memory 无关键词提示要词', () => {
  const { deps, cleanup } = makeDeps()
  try {
    assert.match(tryCommand('/memory', deps)!, /请提供关键词/)
  } finally { cleanup() }
})

test('tryCommand: /memory 关键词命中 episodes', () => {
  const { deps, cleanup } = makeDeps()
  try {
    deps.store.insertEpisode({
      id: 'e1', timestamp: new Date().toISOString(), source: 'chat', role: 'user',
      content: '我下周要去深圳出差', summary: null, embedding: null,
      session_id: 's1', topic_tags: null, entities: null,
    })
    const out = tryCommand('/memory 深圳', deps)
    assert.match(out!, /深圳/)
    assert.match(out!, /关于"深圳"/)
  } finally { cleanup() }
})

test('tryCommand: /memory 无任何命中返回没找到', () => {
  const { deps, cleanup } = makeDeps()
  try {
    assert.match(tryCommand('/memory 不存在的词xyz', deps)!, /没找到关于"不存在的词xyz"/)
  } finally { cleanup() }
})

test('tryCommand: /mem 是 memory 别名(多词 query 拼回)', () => {
  const { deps, cleanup } = makeDeps()
  try {
    // 锁:parts.slice(1).join(' ') 把多段空格分词拼回成 query
    assert.match(tryCommand('/mem 不存在 的词', deps)!, /没找到关于"不存在 的词"/)
  } finally { cleanup() }
})
