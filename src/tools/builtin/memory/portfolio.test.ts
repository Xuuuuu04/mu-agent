import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ToolContext, Position } from '../../../core/types.js'
import { portfolioAddTool, portfolioUpdateTool, portfolioRemoveTool } from './portfolio.js'

function withDataDir(fn: (dataDir: string, ctx: ToolContext) => Promise<void>): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'mu-port-'))
  const ctx = { dataDir, log: () => {} } as unknown as ToolContext
  return fn(dataDir, ctx).finally(() => rmSync(dataDir, { recursive: true, force: true }))
}

function readPortfolio(dataDir: string): Position[] {
  const p = join(dataDir, 'memory', 'portfolio.json')
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : []
}

test('portfolio_add: 新建落盘,带止损止盈', () => withDataDir(async (dataDir, ctx) => {
  const r = await portfolioAddTool.execute(
    { code: '003816', name: '中国广核', qty: 100, cost: 3.87, stop_loss: 3.7, take_profit: 4.1 }, ctx)
  assert.equal(r.success, true)
  const [p] = readPortfolio(dataDir)
  assert.equal(p!.code, '003816')
  assert.equal(p!.qty, 100)
  assert.equal(p!.cost, 3.87)
  assert.equal(p!.stop_loss, 3.7)
  assert.equal(p!.status, 'active')
}))

test('portfolio_add: 同 code 加仓 → 加权平均成本 + 数量合并', () => withDataDir(async (dataDir, ctx) => {
  await portfolioAddTool.execute({ code: '003816', name: '中国广核', qty: 100, cost: 3.8 }, ctx)
  await portfolioAddTool.execute({ code: '003816', name: '中国广核', qty: 100, cost: 4.0 }, ctx)
  const [p] = readPortfolio(dataDir)
  assert.equal(p!.qty, 200)
  // (3.8*100 + 4.0*100)/200 = 3.9
  assert.equal(p!.cost, 3.9)
}))

test('portfolio_add: 缺 code/qty/cost → 拒绝', () => withDataDir(async (_d, ctx) => {
  const r = await portfolioAddTool.execute({ code: '', name: 'x', qty: 100, cost: 1 }, ctx)
  assert.equal(r.success, false)
  const r2 = await portfolioAddTool.execute({ code: '001', name: 'x', qty: 0, cost: 1 } as never, ctx)
  assert.equal(r2.success, false)
}))

test('portfolio_update: 设止损止盈 + 清仓', () => withDataDir(async (dataDir, ctx) => {
  await portfolioAddTool.execute({ code: '003816', name: '中国广核', qty: 100, cost: 3.87 }, ctx)
  const [before] = readPortfolio(dataDir)
  const r = await portfolioUpdateTool.execute({ id: before!.id, stop_loss: 3.7, take_profit: 4.1 }, ctx)
  assert.equal(r.success, true)
  const [mid] = readPortfolio(dataDir)
  assert.equal(mid!.stop_loss, 3.7)

  const r2 = await portfolioUpdateTool.execute({ id: before!.id, close: true }, ctx)
  assert.equal(r2.success, true)
  const [closed] = readPortfolio(dataDir)
  assert.equal(closed!.status, 'closed')
}))

test('portfolio_update: 找不到 id → 失败', () => withDataDir(async (_d, ctx) => {
  const r = await portfolioUpdateTool.execute({ id: 'p_nope', stop_loss: 3 }, ctx)
  assert.equal(r.success, false)
}))

test('portfolio_remove: 硬删除', () => withDataDir(async (dataDir, ctx) => {
  await portfolioAddTool.execute({ code: '003816', name: '中国广核', qty: 100, cost: 3.87 }, ctx)
  const [before] = readPortfolio(dataDir)
  await portfolioRemoveTool.execute({ id: before!.id }, ctx)
  assert.equal(readPortfolio(dataDir).length, 0)
}))
