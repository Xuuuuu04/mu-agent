import type { ToolDef } from '../../../core/types.js'
import {
  ResearchIntelligenceStore, attributePortfolio, calculateValuationSnapshot,
  evaluateDecisionOutcome, evaluateMarketSession, reconcileQuotes,
  type AttributionInput, type OutcomeInput, type QuoteObservation,
  type RawMarketEvent, type SessionAuditInput, type ValuationInput,
} from '../../../finance/research-intelligence.js'
import { errorResult, jsonResult } from './_shared.js'

function objects(value: unknown, field: string, max = 500): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.some(x => !x || typeof x !== 'object' || Array.isArray(x))) {
    throw new TypeError(`${field} must be an array of objects`)
  }
  if (value.length > max) throw new TypeError(`${field} exceeds ${max} entries`)
  return value as Array<Record<string, unknown>>
}

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some(x => typeof x !== 'string')) throw new TypeError(`${field} must be a string array`)
  if (value.length > 500) throw new TypeError(`${field} exceeds 500 entries`)
  return value as string[]
}

function intelligence(ctx: { dataDir: string }): ResearchIntelligenceStore {
  return new ResearchIntelligenceStore(ctx.dataDir)
}

export const aStockQuoteReconcileTool: ToolDef = {
  name: 'a_stock_quote_reconcile',
  description: '对已经取得的多源 A 股行情做 freshness/quorum/差异检测并留证。不联网、不下单',
  parameters: {
    code: { type: 'string', description: '本次行情对应的6位证券代码' },
    observations: { type: 'array', description: '行情数组:{source,price,asOf}' },
    now: { type: 'string', description: '校验基准 ISO 时间' },
    max_age_seconds: { type: 'number', description: '最大新鲜度,默认15', required: false },
    tolerance_bps: { type: 'number', description: '来源价差容忍基点,默认20', required: false },
    min_sources: { type: 'number', description: '形成 quorum 的最少来源,默认2', required: false },
  },
  requiredKeys: ['code', 'observations', 'now'],
  async execute(params, ctx) {
    try {
      const observations = objects(params.observations, 'observations', 20).map(x => ({
        source: String(x.source ?? ''), price: Number(x.price), asOf: String(x.asOf ?? ''),
      })) as QuoteObservation[]
      const now = new Date(String(params.now))
      if (!Number.isFinite(now.getTime())) throw new TypeError('now must be an ISO timestamp')
      const result = reconcileQuotes(observations, now, {
        maxAgeSeconds: finite(params.max_age_seconds, 15, 1, 3600, 'max_age_seconds'),
        toleranceBps: finite(params.tolerance_bps, 20, 1, 1000, 'tolerance_bps'),
        minSources: finite(params.min_sources, 2, 1, 10, 'min_sources'),
      })
      const code = String(params.code)
      if (!/^\d{6}$/.test(code)) throw new TypeError('code must be 6 digits')
      intelligence(ctx).saveQuoteCheck({ code, ...result, checkedAt: now.toISOString(), observations })
      return jsonResult(result)
    } catch (error) { return errorResult(error) }
  },
}

export const aStockEventIngestTool: ToolDef = {
  name: 'a_stock_event_ingest',
  description: '把巨潮公告/新闻结果规范化、去重并与持仓关联;重大事件标记确定性告警需求',
  parameters: {
    events: { type: 'array', description: '事件数组:{source,title,publishedAt,url?,content?}' },
    position_codes: { type: 'array', description: '当前持仓代码数组' },
  },
  requiredKeys: ['events', 'position_codes'],
  async execute(params, ctx) {
    try {
      const events = objects(params.events, 'events', 200).map(x => ({
        source: String(x.source ?? ''), title: String(x.title ?? ''), publishedAt: String(x.publishedAt ?? ''),
        ...(x.url === undefined ? {} : { url: String(x.url) }),
        ...(x.content === undefined ? {} : { content: String(x.content) }),
      })) as RawMarketEvent[]
      const all = intelligence(ctx).ingestEvents(events, strings(params.position_codes, 'position_codes'))
      return jsonResult({ ingested: events.length, total: all.length, alerts: all.filter(x => x.requiresAlert).slice(0, 20) })
    } catch (error) { return errorResult(error) }
  },
}

export const aStockValuationRecordTool: ToolDef = {
  name: 'a_stock_valuation_record',
  description: '记录带时间、覆盖度和熊/基/牛假设的结构化估值快照;不使用固定通用PE锚点',
  parameters: {
    code: { type: 'string', description: '6位代码' }, as_of: { type: 'string', description: '证据时间ISO' },
    price: { type: 'number', description: '现价' }, eps_ttm: { type: 'number', description: 'TTM EPS', required: false },
    book_value_per_share: { type: 'number', description: '每股净资产', required: false },
    forward_eps: { type: 'number', description: '前向EPS', required: false },
    next_forward_eps: { type: 'number', description: '下一年前向EPS', required: false },
    analyst_count: { type: 'number', description: '一致预期机构数', required: false },
    target_pe: { type: 'object', description: '行业/公司特定熊基牛PE:{bear,base,bull}' },
    evidence: { type: 'object', description: '字段级来源时间:{price:{source,asOf},forwardEps:{source,asOf},...}' },
  },
  requiredKeys: ['code', 'as_of', 'price', 'target_pe', 'evidence'],
  async execute(params, ctx) {
    try {
      const target = params.target_pe as Record<string, unknown>
      if (!target || typeof target !== 'object' || Array.isArray(target)) throw new TypeError('target_pe must be an object')
      const evidenceRaw = params.evidence as Record<string, unknown>
      if (!evidenceRaw || typeof evidenceRaw !== 'object' || Array.isArray(evidenceRaw)) throw new TypeError('evidence must be an object')
      const evidence = Object.fromEntries(Object.entries(evidenceRaw).map(([field, raw]) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`evidence.${field} must be an object`)
        const item = raw as Record<string, unknown>
        return [field, { source: String(item.source ?? ''), asOf: String(item.asOf ?? '') }]
      })) as ValuationInput['evidence']
      const input: ValuationInput = {
        code: String(params.code), asOf: String(params.as_of), price: Number(params.price),
        ...(params.eps_ttm === undefined ? {} : { epsTtm: Number(params.eps_ttm) }),
        ...(params.book_value_per_share === undefined ? {} : { bookValuePerShare: Number(params.book_value_per_share) }),
        ...(params.forward_eps === undefined ? {} : { forwardEps: Number(params.forward_eps) }),
        ...(params.next_forward_eps === undefined ? {} : { nextForwardEps: Number(params.next_forward_eps) }),
        ...(params.analyst_count === undefined ? {} : { analystCount: Number(params.analyst_count) }),
        targetPe: { bear: Number(target.bear), base: Number(target.base), bull: Number(target.bull) },
        evidence,
      }
      const result = calculateValuationSnapshot(input)
      intelligence(ctx).saveValuation(result)
      return jsonResult(result)
    } catch (error) { return errorResult(error) }
  },
}

export const portfolioAttributionRecordTool: ToolDef = {
  name: 'portfolio_attribution_record',
  description: '按持仓与行业记录组合收益贡献、费用和相对基准表现;仅研究/模拟分析',
  parameters: {
    as_of: { type: 'string', description: '归因截止时间ISO' }, start_equity: { type: 'number', description: '期初权益' },
    actual_end_equity: { type: 'number', description: '独立账本观测的期末权益' }, net_cash_flow: { type: 'number', description: '期间外部净入金(入金为正)' },
    benchmark_return: { type: 'number', description: '同期基准收益' }, fees: { type: 'number', description: '佣金、税费等显式费用(不含滑点)' },
    slippage: { type: 'number', description: '独立滑点成本' },
    positions: { type: 'array', description: '数组:{code,sector,qty,startPrice,endPrice}' },
  },
  requiredKeys: ['as_of', 'start_equity', 'actual_end_equity', 'net_cash_flow', 'benchmark_return', 'fees', 'slippage', 'positions'],
  async execute(params, ctx) {
    try {
      if (!Number.isFinite(Date.parse(String(params.as_of)))) throw new TypeError('as_of must be ISO time')
      const input: AttributionInput = {
        startEquity: Number(params.start_equity), actualEndEquity: Number(params.actual_end_equity), netCashFlow: Number(params.net_cash_flow),
        benchmarkReturn: Number(params.benchmark_return), fees: Number(params.fees), slippage: Number(params.slippage),
        positions: objects(params.positions, 'positions').map(x => ({ code: String(x.code ?? ''), sector: String(x.sector ?? ''),
          qty: Number(x.qty), startPrice: Number(x.startPrice), endPrice: Number(x.endPrice) })),
      }
      const result = { asOf: String(params.as_of), ...attributePortfolio(input) }
      intelligence(ctx).saveAttribution(result)
      return jsonResult(result)
    } catch (error) { return errorResult(error) }
  },
}

export const investmentOutcomeRecordTool: ToolDef = {
  name: 'investment_outcome_record',
  description: '在固定观察窗记录投资决策的绝对/超额收益、MFE/MAE和命中结果,防止事后挑样本',
  parameters: {
    decision_id: { type: 'string', description: '决策ID' }, horizon_days: { type: 'number', description: '预先约定日历观察天数,due_at必须匹配' },
    decision_at: { type: 'string', description: '决策形成时间 ISO' }, due_at: { type: 'string', description: '预先锁定的观察窗到期时间 ISO' },
    observed_at: { type: 'string', description: '实际评价时间 ISO,不得早于 due_at' },
    action: { type: 'string', enum: ['buy', 'add', 'sell', 'reduce'], description: '决策方向' },
    decision_price: { type: 'number', description: '决策时价格' }, benchmark_price: { type: 'number', description: '决策时基准' },
    observed_price: { type: 'number', description: '观察窗末价格' }, observed_benchmark: { type: 'number', description: '观察窗末基准' },
    high: { type: 'number', description: '观察窗最高价' }, low: { type: 'number', description: '观察窗最低价' },
  },
  requiredKeys: ['decision_id', 'horizon_days', 'decision_at', 'due_at', 'observed_at', 'action', 'decision_price', 'benchmark_price', 'observed_price', 'observed_benchmark', 'high', 'low'],
  async execute(params, ctx) {
    try {
      const horizon = finite(params.horizon_days, 0, 1, 3650, 'horizon_days')
      const input: OutcomeInput = { action: params.action as OutcomeInput['action'], decisionPrice: Number(params.decision_price),
        benchmarkPrice: Number(params.benchmark_price), observedPrice: Number(params.observed_price),
        observedBenchmark: Number(params.observed_benchmark), high: Number(params.high), low: Number(params.low) }
      if (!['buy', 'add', 'sell', 'reduce'].includes(input.action)) throw new TypeError('invalid action')
      const result = { decisionId: String(params.decision_id), horizonDays: horizon,
        decisionAt: String(params.decision_at), dueAt: String(params.due_at), observedAt: String(params.observed_at),
        ...evaluateDecisionOutcome(input) }
      intelligence(ctx).saveOutcome(result)
      return jsonResult(result)
    } catch (error) { return errorResult(error) }
  },
}

export const marketSessionAuditRecordTool: ToolDef = {
  name: 'market_session_audit_record',
  description: '记录真实交易日阶段边界漂移、报价覆盖和重叠抑制,生成可审计日终结论',
  parameters: {
    date: { type: 'string', description: '北京时间交易日 YYYY-MM-DD' }, expected: { type: 'array', description: '预期边界 HH:MM 数组' },
    observed: { type: 'array', description: '实测数组:{boundary,driftSeconds}' }, quote_coverage: { type: 'number', description: '报价覆盖率0-1' },
    overlap_suppressed: { type: 'number', description: '重叠抑制次数' },
  },
  requiredKeys: ['date', 'expected', 'observed', 'quote_coverage', 'overlap_suppressed'],
  async execute(params, ctx) {
    try {
      const input: SessionAuditInput = { date: String(params.date), expected: strings(params.expected, 'expected'),
        observed: objects(params.observed, 'observed').map(x => ({ boundary: String(x.boundary), driftSeconds: Number(x.driftSeconds) })),
        quoteCoverage: Number(params.quote_coverage), overlapSuppressed: Number(params.overlap_suppressed) }
      const result = evaluateMarketSession(input)
      intelligence(ctx).saveSessionAudit(result)
      return jsonResult(result)
    } catch (error) { return errorResult(error) }
  },
}

export const researchIntelligenceStatusTool: ToolDef = {
  name: 'research_intelligence_status', description: '读取多源质量、事件、估值、归因、决策效果和交易日验收的持久化状态',
  parameters: {}, requiredKeys: [],
  async execute(_params, ctx) {
    try { return jsonResult(intelligence(ctx).snapshot()) } catch (error) { return errorResult(error) }
  },
}

function finite(value: unknown, fallback: number, min: number, max: number, field: string): number {
  const n = value === undefined ? fallback : Number(value)
  if (!Number.isFinite(n) || n < min || n > max) throw new TypeError(`${field} must be between ${min} and ${max}`)
  return n
}
