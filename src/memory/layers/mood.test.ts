import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadMood, updateMood } from './mood.js'
import type { MoodState } from '../../core/types.js'

function withDataDir(fn: (dataDir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'mu-mood-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function readMoodFile(dataDir: string): MoodState {
  return JSON.parse(readFileSync(join(dataDir, 'memory', 'mood.json'), 'utf-8'))
}

// ---- loadMood ----

test('loadMood:文件不存在 → null', () => withDataDir((dir) => {
  assert.equal(loadMood(dir), null)
}))

test('loadMood:坏 JSON → null(不抛)', () => withDataDir((dir) => {
  mkdirSync(join(dir, 'memory'), { recursive: true })
  writeFileSync(join(dir, 'memory', 'mood.json'), '{坏的')
  assert.equal(loadMood(dir), null)
}))

test('loadMood:正常读回', () => withDataDir((dir) => {
  mkdirSync(join(dir, 'memory'), { recursive: true })
  const state: MoodState = { current: 'excited', since: '2026-06-15T00:00:00.000Z', reason: '哥哥回来了' }
  writeFileSync(join(dir, 'memory', 'mood.json'), JSON.stringify(state))
  assert.deepEqual(loadMood(dir), state)
}))

// ---- updateMood:写读往返 ----

test('updateMood:首次写入(目录不存在自动建)→ 返回 true,文件落盘', () => withDataDir((dir) => {
  const ok = updateMood(dir, 'missing', '想哥哥了')
  assert.equal(ok, true)
  assert.ok(existsSync(join(dir, 'memory', 'mood.json')))
  const m = readMoodFile(dir)
  assert.equal(m.current, 'missing')
  assert.equal(m.reason, '想哥哥了')
  assert.match(m.since, /^\d{4}-\d{2}-\d{2}T/) // ISO
  assert.equal(m.previous, undefined) // 首次没有 previous
}))

test('updateMood:大小写/空白归一化(MOOD 文本容错)', () => {
  withDataDir((dir) => {
    const ok = updateMood(dir, '  Excited  ', '开心')
    assert.equal(ok, true)
    assert.equal(readMoodFile(dir).current, 'excited')
  })
})

test('updateMood:非法情绪 → 返回 false,不写文件', () => withDataDir((dir) => {
  const ok = updateMood(dir, 'angry', '生气')
  assert.equal(ok, false)
  assert.equal(existsSync(join(dir, 'memory', 'mood.json')), false)
}))

test('updateMood:六种合法情绪都接受', () => {
  for (const mood of ['calm', 'missing', 'emo', 'excited', 'sleepy', 'active']) {
    withDataDir((dir) => {
      assert.equal(updateMood(dir, mood, 'r'), true, `${mood} 应被接受`)
    })
  }
})

test('updateMood:情绪没变(同 current)→ 返回 false,不重写', () => withDataDir((dir) => {
  updateMood(dir, 'calm', '平静')
  const before = readMoodFile(dir).since
  const ok = updateMood(dir, 'calm', '还是平静')  // 同 current
  assert.equal(ok, false)
  // 文件未被改写:since 不变,reason 也不变(没走写入分支)
  const after = readMoodFile(dir)
  assert.equal(after.since, before)
  assert.equal(after.reason, '平静')
}))

test('updateMood:情绪转变 → previous 记录上一个 mood + 其 since', () => withDataDir((dir) => {
  updateMood(dir, 'calm', '平静')
  const firstSince = readMoodFile(dir).since
  const ok = updateMood(dir, 'missing', '想他了')
  assert.equal(ok, true)
  const m = readMoodFile(dir)
  assert.equal(m.current, 'missing')
  assert.deepEqual(m.previous, { mood: 'calm', changed_at: firstSince })
}))

test('updateMood:空 reason 时回退到上一个 reason', () => withDataDir((dir) => {
  updateMood(dir, 'calm', '本来的原因')
  updateMood(dir, 'excited', '') // 空 reason → 用 prev.reason
  assert.equal(readMoodFile(dir).reason, '本来的原因')
}))

test('updateMood:空 reason 且无 prev → 空字符串', () => withDataDir((dir) => {
  updateMood(dir, 'sleepy', '')
  assert.equal(readMoodFile(dir).reason, '')
}))

test('updateMood → loadMood 往返一致', () => withDataDir((dir) => {
  updateMood(dir, 'active', '在忙活')
  const loaded = loadMood(dir)
  assert.equal(loaded?.current, 'active')
  assert.equal(loaded?.reason, '在忙活')
}))
