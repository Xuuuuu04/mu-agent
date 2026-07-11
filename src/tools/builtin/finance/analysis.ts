import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import type { ToolDef, ToolResult } from '../../../core/types.js'
import { runPresetShell } from '../shell.js'

const STRATEGIES = new Set(['ma_cross', 'bollinger', 'rsi_reversal'])
const PRICE_LIMIT_PCTS = new Set([0, 0.05, 0.10, 0.20, 0.30])
const SAFE_PATH = /^[\p{L}\p{N}._/\- ]+$/u

function error(message: string): ToolResult {
  return { success: false, output: '', error: message }
}

function compactDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{8}$/.test(value)) return null
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(4, 6))
  const day = Number(value.slice(6, 8))
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
    ? value
    : null
}

export const aStockBacktestTool: ToolDef = {
  name: 'a_stock_backtest',
  description: '运行 A 股历史策略回测（next-bar、T+1、整手、费用、滑点和涨跌停约束）。仅历史模拟，不连接券商、不下单、不保证收益',
  parameters: {
    symbol: { type: 'string', description: '6 位 A 股证券代码' },
    start: { type: 'string', description: '开始日期 YYYYMMDD' },
    end: { type: 'string', description: '结束日期 YYYYMMDD' },
    strategy: { type: 'string', enum: [...STRATEGIES], description: '预置策略' },
    price_limit_pct: { type: 'number', enum: [...PRICE_LIMIT_PCTS], description: '可选涨跌停比例：0、0.05、0.10、0.20 或 0.30' },
  },
  requiredKeys: ['symbol', 'start', 'end', 'strategy'],
  async execute(params) {
    const command = buildBacktestCommand(params)
    if (!command) {
      if (params.price_limit_pct !== undefined
        && (typeof params.price_limit_pct !== 'number' || !Number.isFinite(params.price_limit_pct)
          || !PRICE_LIMIT_PCTS.has(params.price_limit_pct))) return error('涨跌停比例只允许 0、0.05、0.10、0.20 或 0.30')
      if (typeof params.symbol !== 'string' || !/^\d{6}$/.test(params.symbol)) return error('证券代码必须是 6 位数字')
      const start = compactDate(params.start)
      const end = compactDate(params.end)
      if (!start || !end || start > end) return error('日期必须是合法 YYYYMMDD，且开始日期不能晚于结束日期')
      return error('策略必须是 ma_cross、bollinger 或 rsi_reversal')
    }
    return runPresetShell(command, 120_000, 12_000)
  },
}

export function buildBacktestCommand(params: Record<string, unknown>): string | null {
  const symbol = typeof params.symbol === 'string' && /^\d{6}$/.test(params.symbol) ? params.symbol : null
  const start = compactDate(params.start)
  const end = compactDate(params.end)
  const strategy = typeof params.strategy === 'string' && STRATEGIES.has(params.strategy) ? params.strategy : null
  const limit = params.price_limit_pct
  if (!symbol || !start || !end || start > end || !strategy) return null
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isFinite(limit) || !PRICE_LIMIT_PCTS.has(limit))) return null
  const suffix = limit === undefined ? '' : ` --price-limit-pct ${String(limit)}`
  return `./scripts/run-backtest.sh --symbol "${symbol}" --start "${start}" --end "${end}" --strategy "${strategy}"${suffix}`
}

function resolveSnapshot(dataDir: string, value: unknown): string | null {
  if (typeof value !== 'string' || !value.endsWith('.json') || !SAFE_PATH.test(value)) return null
  const withoutDataPrefix = value.replace(/^data\//, '')
  const full = resolve(dataDir, withoutDataPrefix)
  const lexicalRoot = resolve(dataDir)
  const rel = relative(lexicalRoot, full)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  if (!existsSync(full)) return null
  try {
    const realRoot = realpathSync(lexicalRoot)
    const realTarget = realpathSync(full)
    const realRel = relative(realRoot, realTarget)
    if (realRel === '' || realRel.startsWith('..') || isAbsolute(realRel)) return null
    if (!statSync(realTarget).isFile()) return null
    return realTarget
  } catch {
    return null
  }
}

export const mxAnalyzeTool: ToolDef = {
  name: 'mx_analyze',
  description: '分析 data 目录内已标准化的模拟盘 JSON，计算盈亏、暴露、集中度并与最近回测对比。不调用模拟交易或真实券商接口',
  parameters: {
    snapshot_path: { type: 'string', description: 'data 目录内 schema_version=1 的模拟账户 JSON 路径' },
  },
  requiredKeys: ['snapshot_path'],
  async execute(params, ctx) {
    const snapshot = resolveSnapshot(ctx.dataDir, params.snapshot_path)
    if (!snapshot) return error('快照路径必须是 data 目录内的 JSON 文件，禁止路径逃逸')
    const backtestRelative = 'backtest/latest-report.json'
    const backtestLexical = resolve(ctx.dataDir, backtestRelative)
    const backtest = existsSync(backtestLexical) ? resolveSnapshot(ctx.dataDir, backtestRelative) : null
    if (existsSync(backtestLexical) && !backtest) return error('回测报告路径不安全，已拒绝分析')
    const backtestArg = backtest ? ` --backtest "${backtest}"` : ''
    return runPresetShell(
      `./scripts/run-simulation-analysis.sh --snapshot "${snapshot}"${backtestArg}`,
      60_000,
      12_000,
    )
  },
}
