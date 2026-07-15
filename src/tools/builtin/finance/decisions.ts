import type { ToolDef } from '../../../core/types.js'
import { DecisionJournalStore } from '../../../finance/research-store.js'
import type { DecisionRecord } from '../../../finance/types.js'
import { errorResult, jsonResult } from './_shared.js'

export const investmentDecisionRecordTool: ToolDef = {
  name: 'investment_decision_record',
  description: '追加一条不可覆盖的投资决策日志；买入/加仓/减仓/卖出必须固定证券、决策价、沪深300基准价和观察天数，供到期自动复盘；不下单、不连接券商',
  parameters: {
    action: { type: 'string', description: 'buy/add/reduce/sell/hold/watch/avoid' },
    rationale: { type: 'string', description: '决策理由' },
    case_id: { type: 'string', description: '关联 case ID', required: false },
    position_id: { type: 'string', description: '关联持仓 ID', required: false },
    expected_outcome: { type: 'string', description: '预期结果' },
    invalidation: { type: 'string', description: '决策失效条件' },
    evidence_ids: { type: 'array', items: { type: 'string' }, description: '关联 evidence ID', required: false },
    code: { type: 'string', description: '可执行决策对应的 6 位证券代码；hold/watch/avoid 不传', required: false },
    decision_price: { type: 'number', description: '决策时经多源校验的证券价格', required: false },
    benchmark_code: { type: 'string', description: '基准代码，默认使用 000300 但必须显式留证', required: false },
    benchmark_price: { type: 'number', description: '决策时同一时点的基准价格', required: false },
    horizon_days: { type: 'number', description: '固定自然日观察窗口，1-3650 的整数', required: false },
    decision_price_source: { type: 'string', description: '决策价来源，例如 ifind+tencent quorum', required: false },
    decision_price_as_of: { type: 'string', description: '决策价源时间，必须在决策写入前五分钟内', required: false },
    benchmark_source: { type: 'string', description: '基准价格来源', required: false },
    benchmark_as_of: { type: 'string', description: '基准价格源时间，必须在决策写入前五分钟内', required: false },
  },
  requiredKeys: ['action', 'rationale', 'expected_outcome', 'invalidation'],
  async execute(params, ctx) {
    try {
      const value = new DecisionJournalStore(ctx.dataDir).record({
        ...params,
        evidence_ids: params.evidence_ids ?? [],
      } as unknown as DecisionRecord)
      return jsonResult(value)
    } catch (error) {
      return errorResult(error)
    }
  },
}

export const investmentDecisionListTool: ToolDef = {
  name: 'investment_decision_list',
  description: '列出投资决策日志，可按 case/position 过滤',
  parameters: {
    case_id: { type: 'string', description: '关联 case ID', required: false },
    position_id: { type: 'string', description: '关联持仓 ID', required: false },
  },
  requiredKeys: [],
  parallelSafe: true,
  async execute(params, ctx) {
    try {
      const caseId = params.case_id === undefined ? undefined : String(params.case_id).trim()
      const positionId = params.position_id === undefined ? undefined : String(params.position_id).trim()
      return jsonResult(new DecisionJournalStore(ctx.dataDir).list({ case_id: caseId, position_id: positionId }))
    } catch (error) {
      return errorResult(error)
    }
  },
}
