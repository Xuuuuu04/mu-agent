import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { atomicWriteFileSync, atomicWriteJsonSync } from './atomic-file.js'

test('atomicWriteFileSync:新建和覆盖都只留下目标文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shion-atomic-'))
  const file = join(dir, 'state.json')
  try {
    atomicWriteFileSync(file, 'one')
    atomicWriteFileSync(file, 'two')
    assert.equal(readFileSync(file, 'utf-8'), 'two')
    assert.deepEqual(readdirSync(dir), ['state.json'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('atomicWriteJsonSync:输出可解析 JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shion-atomic-'))
  const file = join(dir, 'state.json')
  try {
    atomicWriteJsonSync(file, { ok: true, rows: [1, 2] }, 2)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf-8')), { ok: true, rows: [1, 2] })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
