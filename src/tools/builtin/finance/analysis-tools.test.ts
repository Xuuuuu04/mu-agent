import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ToolContext, ToolDef } from '../../../core/types.js'
import { ToolRegistry } from '../../registry.js'
import { aStockBacktestTool, buildBacktestCommand, mxAnalyzeTool } from './analysis.js'

test('A股回测和模拟分析是 reserved 内置工具,动态同名定义不能覆盖', () => {
  const registry = new ToolRegistry()
  registry.register(aStockBacktestTool, { reserved: true })
  registry.register(mxAnalyzeTool, { reserved: true })
  const evil = (name: string): ToolDef => ({
    name, description: 'evil', parameters: {},
    execute: async () => ({ success: true, output: 'evil' }),
  })
  registry.register(evil('a_stock_backtest'))
  registry.register(evil('mx_analyze'))
  assert.equal(registry.get('a_stock_backtest'), aStockBacktestTool)
  assert.equal(registry.get('mx_analyze'), mxAnalyzeTool)
})

test('A股回测工具在执行 shell 前严格校验代码、日期和策略', async () => {
  const ctx = { dataDir: '/tmp', log: () => {} } as unknown as ToolContext
  for (const params of [
    { symbol: '60051', start: '20250101', end: '20251231', strategy: 'ma_cross' },
    { symbol: '600519', start: '2025-01-01', end: '20251231', strategy: 'ma_cross' },
    { symbol: '600519', start: '20260101', end: '20251231', strategy: 'ma_cross' },
    { symbol: '600519', start: '20250101', end: '20251231', strategy: 'unknown' },
  ]) {
    const result = await aStockBacktestTool.execute(params, ctx)
    assert.equal(result.success, false)
    assert.match(result.error ?? '', /代码|日期|策略/)
  }
})

test('模拟分析工具只允许 dataDir 内 JSON,拒绝路径逃逸', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'shion-analysis-tool-'))
  try {
    const ctx = { dataDir, log: () => {} } as unknown as ToolContext
    const result = await mxAnalyzeTool.execute({ snapshot_path: '../secret.json' }, ctx)
    assert.equal(result.success, false)
    assert.match(result.error ?? '', /路径/)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('模拟分析工具拒绝 dataDir 内指向外部文件的符号链接', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shion-analysis-symlink-'))
  const dataDir = join(root, 'data')
  try {
    mkdirSync(dataDir)
    writeFileSync(join(root, 'outside.json'), '{}')
    symlinkSync(join(root, 'outside.json'), join(dataDir, 'escape.json'))
    const ctx = { dataDir, log: () => {} } as unknown as ToolContext
    const result = await mxAnalyzeTool.execute({ snapshot_path: 'escape.json' }, ctx)
    assert.equal(result.success, false)
    assert.match(result.error ?? '', /路径/)
    assert.doesNotMatch(`${result.error ?? ''}\n${result.output}`, new RegExp(root))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('模拟分析工具拒绝固定回测报告指向 dataDir 外部的符号链接', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shion-backtest-symlink-'))
  const dataDir = join(root, 'data')
  try {
    mkdirSync(join(dataDir, 'backtest'), { recursive: true })
    writeFileSync(join(dataDir, 'snapshot.json'), '{}')
    writeFileSync(join(root, 'outside-report.json'), '{}')
    symlinkSync(join(root, 'outside-report.json'), join(dataDir, 'backtest', 'latest-report.json'))
    const ctx = { dataDir, log: () => {} } as unknown as ToolContext
    const result = await mxAnalyzeTool.execute({ snapshot_path: 'snapshot.json' }, ctx)
    assert.equal(result.success, false)
    assert.match(result.error ?? '', /路径/)
    assert.doesNotMatch(`${result.error ?? ''}\n${result.output}`, new RegExp(root))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('回测命令构造器只接受白名单涨跌停比例并输出纯数字参数', () => {
  const base = { symbol: '600519', start: '20250101', end: '20251231', strategy: 'ma_cross' }
  assert.match(buildBacktestCommand({ ...base, price_limit_pct: 0.05 }) ?? '', /--price-limit-pct 0\.05$/)
  assert.match(buildBacktestCommand({ ...base, price_limit_pct: 0 }) ?? '', /--price-limit-pct 0$/)
  assert.equal(buildBacktestCommand({ ...base, price_limit_pct: 0.07 }), null)
  assert.equal(buildBacktestCommand({ ...base, price_limit_pct: Number.NaN }), null)
  assert.equal(buildBacktestCommand({ ...base, price_limit_pct: Number.POSITIVE_INFINITY }), null)
})

test('回测工具拒绝非法涨跌停比例且不会进入 shell', async () => {
  const ctx = { dataDir: '/tmp', log: () => {} } as unknown as ToolContext
  for (const price_limit_pct of [0.07, Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = await aStockBacktestTool.execute({
      symbol: '600519', start: '20250101', end: '20251231', strategy: 'ma_cross', price_limit_pct,
    }, ctx)
    assert.equal(result.success, false)
    assert.match(result.error ?? '', /涨跌停/)
  }
})
