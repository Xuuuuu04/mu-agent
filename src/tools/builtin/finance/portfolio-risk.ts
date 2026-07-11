import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Position, ToolDef } from '../../../core/types.js'
import { atomicWriteJsonSync } from '../../../core/atomic-file.js'
import {
  analyzePortfolioRisk,
  PORTFOLIO_RISK_LATEST_FILE,
} from '../../../finance/portfolio-risk.js'
import type { MarketSnapshot } from '../../../finance/portfolio-risk.js'
import { errorResult, jsonResult } from './_shared.js'

const PORTFOLIO_FILE = 'memory/portfolio.json'
const WATCHDOG_HEALTH_FILE = 'memory/watchdog-health.json'

interface WatchdogSnapshotState {
  status: 'idle' | 'healthy' | 'degraded'
  as_of?: unknown
  prices?: unknown
}

function loadPortfolio(dataDir: string): Position[] {
  const path = join(dataDir, PORTFOLIO_FILE)
  if (!existsSync(path)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`portfolio state is corrupt: ${detail}`, { cause: error })
  }
  if (!Array.isArray(parsed)) throw new Error('portfolio state is corrupt: root must be an array')
  return parsed as Position[]
}

function loadWatchdogSnapshot(dataDir: string): WatchdogSnapshotState {
  const path = join(dataDir, WATCHDOG_HEALTH_FILE)
  if (!existsSync(path)) throw new Error('watchdog snapshot is missing')
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`watchdog snapshot is invalid: ${detail}`, { cause: error })
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('watchdog snapshot is invalid: root must be an object')
  }
  const state = parsed as Record<string, unknown>
  if (state.status !== 'idle' && state.status !== 'healthy' && state.status !== 'degraded') {
    throw new Error('watchdog snapshot is invalid: status must be idle, healthy, or degraded')
  }
  return state as unknown as WatchdogSnapshotState
}

function snapshotPrices(value: unknown): Record<string, number> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('prices must be an object map from an explicit or watchdog snapshot')
  }
  if (Object.keys(value).length === 0) throw new TypeError('prices snapshot is missing or empty')
  return value as Record<string, number>
}

export const portfolioRiskAnalyzeTool: ToolDef = {
  name: 'portfolio_risk_analyze',
  description: '用显式市场快照或 watchdog 已落盘快照分析当前持仓风险。不联网、不猜价、不下单',
  parameters: {
    as_of: { type: 'string', description: '价格快照时间 ISO，缺省读 watchdog-health.json', required: false },
    prices: { type: 'object', description: '证券代码到正数现价的映射，缺省读 watchdog-health.json', required: false },
    sectors: { type: 'object', description: '证券代码到行业的映射', required: false },
    now: { type: 'string', description: '分析基准时间 ISO（用于确定性重放）', required: false },
    max_age_minutes: { type: 'number', description: '快照超过多少分钟视为 stale，默认 15', required: false },
  },
  requiredKeys: [],
  async execute(params, ctx) {
    try {
      if (params.sectors !== undefined
        && (params.sectors === null || typeof params.sectors !== 'object' || Array.isArray(params.sectors))) {
        throw new TypeError('sectors must be an object map')
      }
      if (params.max_age_minutes !== undefined
        && (typeof params.max_age_minutes !== 'number'
          || !Number.isFinite(params.max_age_minutes)
          || params.max_age_minutes < 0)) {
        throw new TypeError('max_age_minutes must be a finite non-negative number')
      }
      const watchdog = params.as_of === undefined || params.prices === undefined
        ? loadWatchdogSnapshot(ctx.dataDir)
        : undefined
      const snapshot: MarketSnapshot = {
        as_of: (params.as_of ?? watchdog?.as_of) as string,
        prices: snapshotPrices(params.prices ?? watchdog?.prices),
        sectors: params.sectors as Record<string, string> | undefined,
      }
      const report = analyzePortfolioRisk(loadPortfolio(ctx.dataDir), snapshot, {
        now: params.now === undefined ? new Date().toISOString() : params.now as string,
        max_price_age_ms: params.max_age_minutes === undefined ? undefined : params.max_age_minutes * 60_000,
      })
      if (report.is_stale) throw new Error(`market snapshot is stale: as_of=${report.snapshot_as_of}`)
      const missingPriceCodes = report.positions
        .filter(position => position.price === null)
        .map(position => position.code)
      if (missingPriceCodes.length > 0) {
        throw new Error(`market snapshot missing valid prices for active positions: ${missingPriceCodes.join(', ')}`)
      }
      atomicWriteJsonSync(join(ctx.dataDir, PORTFOLIO_RISK_LATEST_FILE), report, 2)
      return jsonResult(report)
    } catch (error) {
      return errorResult(error)
    }
  },
}
