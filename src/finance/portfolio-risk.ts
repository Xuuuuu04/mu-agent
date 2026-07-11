import type { Position } from '../core/types.js'

export const PORTFOLIO_RISK_LATEST_FILE = 'memory/portfolio-risk-latest.json'
// 允许采集端与分析端最多 60 秒时钟偏差；再新的“未来价格”无法证明已发生，必须拒绝。
export const MAX_FUTURE_SNAPSHOT_SKEW_MS = 60_000

export interface MarketSnapshot {
  as_of: string
  prices: Record<string, number>
  sectors?: Record<string, string>
}

export interface PortfolioRiskOptions {
  now: string
  max_price_age_ms?: number
}

export type PortfolioRiskWarningType = 'stale_snapshot' | 'missing_price' | 'missing_stop' | 'zero_total'

export interface PortfolioRiskWarning {
  type: PortfolioRiskWarningType
  message: string
  code?: string
}

export interface PositionRiskMetric {
  id: string
  code: string
  name: string
  qty: number
  cost: number
  price: number | null
  cost_value: number
  market_value: number | null
  pnl: number | null
  return: number | null
  weight: number | null
  sector: string | null
  stop_loss: number | null
  max_loss_to_stop: number | null
}

export interface PortfolioRiskReport {
  generated_at: string
  snapshot_as_of: string
  price_age_ms: number
  is_stale: boolean
  is_complete: boolean
  position_count: number
  priced_position_count: number
  stop_covered_position_count: number
  total_market_value: number
  total_cost: number
  total_pnl: number
  total_return: number
  top_weight: number
  hhi: number
  sector_weights: Record<string, number>
  max_loss_to_stop: number
  positions: PositionRiskMetric[]
  warnings: PortfolioRiskWarning[]
}

function fail(message: string): never {
  throw new TypeError(message)
}

function finitePositive(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) fail(`${field} must be a finite positive number`)
  return value
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) {
    fail(`${field} must be an ISO timestamp`)
  }
  return value
}

function round(value: number): number {
  return Number(value.toFixed(10))
}

function validateSnapshot(snapshot: MarketSnapshot): void {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) fail('snapshot must be an object')
  timestamp(snapshot.as_of, 'snapshot.as_of')
  if (snapshot.prices === null || typeof snapshot.prices !== 'object' || Array.isArray(snapshot.prices)) {
    fail('snapshot.prices must be an object')
  }
  for (const [code, price] of Object.entries(snapshot.prices)) finitePositive(price, `price for ${code}`)
  if (snapshot.sectors !== undefined) {
    if (snapshot.sectors === null || typeof snapshot.sectors !== 'object' || Array.isArray(snapshot.sectors)) {
      fail('snapshot.sectors must be an object')
    }
    for (const [code, sector] of Object.entries(snapshot.sectors)) {
      if (typeof sector !== 'string' || sector.trim() === '') fail(`sector for ${code} must be a non-empty string`)
    }
  }
}

function validatePosition(position: Position, index: number): void {
  if (position === null || typeof position !== 'object' || Array.isArray(position)) fail(`positions[${index}] must be an object`)
  if (typeof position.id !== 'string' || position.id.trim() === '') fail(`positions[${index}].id must be a non-empty string`)
  if (typeof position.code !== 'string' || position.code.trim() === '') fail(`positions[${index}].code must be a non-empty string`)
  if (typeof position.name !== 'string' || position.name.trim() === '') fail(`positions[${index}].name must be a non-empty string`)
  finitePositive(position.qty, `positions[${index}].qty`)
  finitePositive(position.cost, `positions[${index}].cost`)
  if (position.stop_loss !== undefined) finitePositive(position.stop_loss, `positions[${index}].stop_loss`)
  if (position.status !== 'active' && position.status !== 'closed') fail(`positions[${index}].status is invalid`)
}

export function analyzePortfolioRisk(
  positions: readonly Position[],
  snapshot: MarketSnapshot,
  options: PortfolioRiskOptions,
): PortfolioRiskReport {
  if (!Array.isArray(positions)) fail('positions must be an array')
  validateSnapshot(snapshot)
  const now = timestamp(options.now, 'options.now')
  const maxAge = options.max_price_age_ms ?? 15 * 60_000
  if (typeof maxAge !== 'number' || !Number.isFinite(maxAge) || maxAge < 0) {
    fail('options.max_price_age_ms must be a finite non-negative number')
  }

  const active = positions.filter((position, index) => {
    validatePosition(position, index)
    return position.status === 'active'
  })
  const rawPriceAge = Date.parse(now) - Date.parse(snapshot.as_of)
  if (rawPriceAge < -MAX_FUTURE_SNAPSHOT_SKEW_MS) {
    fail(`snapshot.as_of is too far in the future (clock skew ${-rawPriceAge}ms)`)
  }
  const priceAge = Math.max(0, rawPriceAge)
  const warnings: PortfolioRiskWarning[] = []
  const isStale = priceAge > maxAge
  if (isStale) {
    warnings.push({
      type: 'stale_snapshot',
      message: `market snapshot is stale by ${priceAge - maxAge}ms`,
    })
  }

  const metrics: PositionRiskMetric[] = active.map(position => {
    const price = snapshot.prices[position.code]
    const costValue = round(position.qty * position.cost)
    if (price === undefined) {
      warnings.push({ type: 'missing_price', code: position.code, message: `missing price for ${position.code}` })
      return {
        id: position.id,
        code: position.code,
        name: position.name,
        qty: position.qty,
        cost: position.cost,
        price: null,
        cost_value: costValue,
        market_value: null,
        pnl: null,
        return: null,
        weight: null,
        sector: null,
        stop_loss: position.stop_loss ?? null,
        max_loss_to_stop: null,
      }
    }
    const marketValue = round(position.qty * price)
    const pnl = round(marketValue - costValue)
    if (position.stop_loss === undefined) {
      warnings.push({ type: 'missing_stop', code: position.code, message: `missing stop loss for ${position.code}` })
    }
    const stopRisk = position.stop_loss === undefined
      ? 0
      : round(Math.max(0, price - position.stop_loss) * position.qty)
    return {
      id: position.id,
      code: position.code,
      name: position.name,
      qty: position.qty,
      cost: position.cost,
      price,
      cost_value: costValue,
      market_value: marketValue,
      pnl,
      return: round(pnl / costValue),
      weight: 0,
      sector: snapshot.sectors?.[position.code]?.trim() || '未分类',
      stop_loss: position.stop_loss ?? null,
      max_loss_to_stop: stopRisk,
    }
  })

  const priced = metrics.filter((metric): metric is PositionRiskMetric & {
    price: number
    market_value: number
    pnl: number
    return: number
    weight: number
    sector: string
    max_loss_to_stop: number
  } => metric.price !== null)
  const totalMarketValue = round(priced.reduce((sum, item) => sum + item.market_value, 0))
  const totalCost = round(priced.reduce((sum, item) => sum + item.cost_value, 0))
  const totalPnl = round(priced.reduce((sum, item) => sum + item.pnl, 0))
  const maxLossToStop = round(priced.reduce((sum, item) => sum + item.max_loss_to_stop, 0))
  const stopCoveredCount = priced.filter(item => item.stop_loss !== null).length

  if (totalMarketValue === 0) {
    warnings.push({ type: 'zero_total', message: 'no priced active market value is available' })
  } else {
    for (const metric of priced) metric.weight = round(metric.market_value / totalMarketValue)
  }

  const sectorWeights: Record<string, number> = {}
  if (totalMarketValue > 0) {
    for (const metric of priced) {
      sectorWeights[metric.sector] = round((sectorWeights[metric.sector] ?? 0) + metric.market_value / totalMarketValue)
    }
  }
  const topWeight = priced.length === 0 ? 0 : Math.max(...priced.map(item => item.weight))
  const hhi = round(priced.reduce((sum, item) => sum + item.weight ** 2, 0))

  return {
    generated_at: now,
    snapshot_as_of: snapshot.as_of,
    price_age_ms: priceAge,
    is_stale: isStale,
    is_complete: !isStale
      && priced.length === active.length
      && stopCoveredCount === priced.length
      && totalMarketValue > 0,
    position_count: active.length,
    priced_position_count: priced.length,
    stop_covered_position_count: stopCoveredCount,
    total_market_value: totalMarketValue,
    total_cost: totalCost,
    total_pnl: totalPnl,
    total_return: totalCost === 0 ? 0 : round(totalPnl / totalCost),
    top_weight: round(topWeight),
    hhi,
    sector_weights: sectorWeights,
    max_loss_to_stop: maxLossToStop,
    positions: metrics,
    warnings,
  }
}
