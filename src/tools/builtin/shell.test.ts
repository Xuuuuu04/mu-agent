import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { approveShellRequest, shellExecTool } from './shell.js'
import type { ToolContext } from '../../core/types.js'

const ctx = {} as ToolContext

test('shell_exec:只读诊断命令直接执行', async () => {
  const r = await shellExecTool.execute({ command: 'pwd' }, ctx)
  assert.equal(r.success, true)
  assert.ok(r.output.trim().length > 0)
})

test('shell_exec:有副作用命令不执行,返回待用户批准 id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shion-shell-'))
  const target = join(dir, 'created')
  try {
    const r = await shellExecTool.execute({ command: `touch ${target}` }, ctx)
    assert.equal(r.success, false)
    assert.equal(existsSync(target), false)
    assert.match(r.error ?? '', /\/approve-shell ([a-z0-9_-]+)/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('shell_exec:只有用户命令审批函数能执行原始精确命令,且 id 一次性', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shion-shell-'))
  const target = join(dir, 'approved')
  try {
    const pending = await shellExecTool.execute({ command: `touch ${target}` }, ctx)
    const id = pending.error?.match(/\/approve-shell ([a-z0-9_-]+)/)?.[1]
    assert.ok(id)
    const approved = approveShellRequest(id!)
    assert.match(approved, /已执行/)
    assert.equal(existsSync(target), true)
    assert.match(approveShellRequest(id!), /不存在|过期/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
