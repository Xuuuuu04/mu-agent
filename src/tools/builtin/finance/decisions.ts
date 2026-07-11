import type { ToolDef } from '../../../core/types.js'
import { DecisionJournalStore } from '../../../finance/research-store.js'
import type { DecisionRecord } from '../../../finance/types.js'
import { errorResult, jsonResult } from './_shared.js'

export const investmentDecisionRecordTool: ToolDef = {
  name: 'investment_decision_record',
  description: '追加一条不可覆盖的投资决策日志，不下单、不连接券商',
  parameters: {
    action: { type: 'string', description: 'buy/add/reduce/sell/hold/watch/avoid' },
    rationale: { type: 'string', description: '决策理由' },
    case_id: { type: 'string', description: '关联 case ID', required: false },
    position_id: { type: 'string', description: '关联持仓 ID', required: false },
    expected_outcome: { type: 'string', description: '预期结果' },
    invalidation: { type: 'string', description: '决策失效条件' },
    evidence_ids: { type: 'array', items: { type: 'string' }, description: '关联 evidence ID', required: false },
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
