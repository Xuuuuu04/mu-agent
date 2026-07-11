import type { ToolDef } from '../../../core/types.js'
import { InvestmentCaseStore } from '../../../finance/research-store.js'
import type {
  EvidenceAppend,
  InvestmentCaseStatus,
  InvestmentCaseUpsert,
} from '../../../finance/types.js'
import { errorResult, jsonResult } from './_shared.js'

export const investmentCaseUpsertTool: ToolDef = {
  name: 'investment_case_upsert',
  description: '新建或更新结构化投资研究 case。更新时传 id，原 id/created_at/evidence 不可覆盖',
  parameters: {
    id: { type: 'string', description: '已有 case ID（更新时必填）', required: false },
    code: { type: 'string', description: '证券代码', required: false },
    name: { type: 'string', description: '证券名称', required: false },
    horizon: { type: 'string', description: 'short_term/medium_term/long_term', required: false },
    thesis: { type: 'string', description: '投资逻辑', required: false },
    catalysts: { type: 'array', items: { type: 'string' }, description: '催化剂', required: false },
    risks: { type: 'array', items: { type: 'string' }, description: '风险', required: false },
    invalidation: { type: 'array', items: { type: 'string' }, description: '逻辑失效条件', required: false },
    confidence: { type: 'number', description: '置信度 0-1', required: false },
    status: { type: 'string', description: 'draft/active/invalidated/closed', required: false },
    review_at: { type: 'string', description: '下次复盘时间 ISO', required: false },
  },
  requiredKeys: [],
  async execute(params, ctx) {
    try {
      const value = new InvestmentCaseStore(ctx.dataDir).upsertCase(params as unknown as InvestmentCaseUpsert)
      return jsonResult(value)
    } catch (error) {
      return errorResult(error)
    }
  },
}

export const investmentCaseListTool: ToolDef = {
  name: 'investment_case_list',
  description: '列出结构化投资 case，可按 code/status 过滤',
  parameters: {
    code: { type: 'string', description: '证券代码', required: false },
    status: { type: 'string', description: 'draft/active/invalidated/closed', required: false },
  },
  requiredKeys: [],
  parallelSafe: true,
  async execute(params, ctx) {
    try {
      const code = params.code === undefined ? undefined : String(params.code).trim()
      const status = params.status === undefined ? undefined : params.status as InvestmentCaseStatus
      return jsonResult(new InvestmentCaseStore(ctx.dataDir).listCases({ code, status }))
    } catch (error) {
      return errorResult(error)
    }
  },
}

export const investmentEvidenceAppendTool: ToolDef = {
  name: 'investment_evidence_append',
  description: '向投资 case 追加一条不可覆盖的 evidence，明确区分 fact/inference/hypothesis/action/invalidation',
  parameters: {
    case_id: { type: 'string', description: '关联 case ID' },
    source: { type: 'string', description: '来源' },
    as_of: { type: 'string', description: '证据对应时间 ISO' },
    kind: { type: 'string', description: 'fact/inference/hypothesis/action/invalidation' },
    content: { type: 'string', description: '证据内容' },
  },
  requiredKeys: ['case_id', 'source', 'as_of', 'kind', 'content'],
  async execute(params, ctx) {
    try {
      const caseId = typeof params.case_id === 'string' ? params.case_id : ''
      const value = new InvestmentCaseStore(ctx.dataDir).appendEvidence(
        caseId,
        params as unknown as EvidenceAppend,
      )
      return jsonResult(value)
    } catch (error) {
      return errorResult(error)
    }
  },
}
