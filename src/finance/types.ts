export type InvestmentHorizon = 'short_term' | 'medium_term' | 'long_term'
export type InvestmentCaseStatus = 'draft' | 'active' | 'invalidated' | 'closed'
export type EvidenceKind = 'fact' | 'inference' | 'hypothesis' | 'action' | 'invalidation'
export type DecisionAction = 'buy' | 'add' | 'reduce' | 'sell' | 'hold' | 'watch' | 'avoid'

export interface EvidenceEntry {
  id: string
  case_id: string
  source: string
  as_of: string
  kind: EvidenceKind
  content: string
  created_at: string
}

export interface InvestmentCase {
  id: string
  code: string
  name: string
  horizon: InvestmentHorizon
  thesis: string
  catalysts: string[]
  risks: string[]
  invalidation: string[]
  confidence: number
  status: InvestmentCaseStatus
  review_at: string
  evidence: EvidenceEntry[]
  created_at: string
  updated_at: string
}

export interface InvestmentCaseCreate {
  code: string
  name: string
  horizon: InvestmentHorizon
  thesis: string
  catalysts: string[]
  risks: string[]
  invalidation: string[]
  confidence: number
  status: InvestmentCaseStatus
  review_at: string
}

export type InvestmentCaseUpdate = Partial<InvestmentCaseCreate> & { id: string }
export type InvestmentCaseUpsert = InvestmentCaseCreate | InvestmentCaseUpdate

export interface EvidenceAppend {
  source: string
  as_of: string
  kind: EvidenceKind
  content: string
}

export interface DecisionEntry {
  id: string
  action: DecisionAction
  rationale: string
  case_id?: string
  position_id?: string
  expected_outcome: string
  invalidation: string
  evidence_ids: string[]
  timestamp: string
}

export interface DecisionRecord {
  action: DecisionAction
  rationale: string
  case_id?: string
  position_id?: string
  expected_outcome: string
  invalidation: string
  evidence_ids: string[]
}
