import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWriteJsonSync } from '../core/atomic-file.js'
import type {
  DecisionAction,
  DecisionEntry,
  DecisionRecord,
  EvidenceAppend,
  EvidenceEntry,
  EvidenceKind,
  InvestmentCase,
  InvestmentCaseCreate,
  InvestmentCaseStatus,
  InvestmentCaseUpsert,
  InvestmentHorizon,
} from './types.js'

export const INVESTMENT_CASES_FILE = 'memory/investment-cases.json'
export const DECISION_JOURNAL_FILE = 'memory/decision-journal.json'

const HORIZONS = ['short_term', 'medium_term', 'long_term'] as const
const CASE_STATUSES = ['draft', 'active', 'invalidated', 'closed'] as const
const EVIDENCE_KINDS = ['fact', 'inference', 'hypothesis', 'action', 'invalidation'] as const
const DECISION_ACTIONS = ['buy', 'add', 'reduce', 'sell', 'hold', 'watch', 'avoid'] as const

interface CaseFile {
  version: 1
  cases: InvestmentCase[]
}

interface DecisionFile {
  version: 1
  entries: DecisionEntry[]
}

interface StoreDeps {
  now?: () => string
  id?: (kind: 'case' | 'evidence' | 'decision') => string
}

export class FinanceStateError extends Error {
  constructor(
    message: string,
    readonly code: 'CORRUPT_STATE' | 'VALIDATION_ERROR' | 'NOT_FOUND',
  ) {
    super(message)
    this.name = 'FinanceStateError'
  }
}

function validation(message: string): never {
  throw new FinanceStateError(message, 'VALIDATION_ERROR')
}

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) validation(`${field} must be an object`)
  return value as Record<string, unknown>
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') validation(`${field} must be a non-empty string`)
  return value.trim()
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : nonEmptyString(value, field)
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) validation(`${field} must be an array`)
  return value.map((item, index) => nonEmptyString(item, `${field}[${index}]`))
}

function finiteRange(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    validation(`${field} must be a finite number between ${min} and ${max}`)
  }
  return value
}

function enumValue<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    validation(`${field} must be one of: ${allowed.join(', ')}`)
  }
  return value as T
}

function isoTimestamp(value: unknown, field: string): string {
  const text = nonEmptyString(value, field)
  if (!/^\d{4}-\d{2}-\d{2}T/.test(text) || !Number.isFinite(Date.parse(text))) {
    validation(`${field} must be an ISO timestamp`)
  }
  return text
}

function readJson(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new FinanceStateError(`${label} is corrupt: ${detail}`, 'CORRUPT_STATE')
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function parseEvidence(value: unknown, index: number, caseId: string): EvidenceEntry {
  const item = asObject(value, `evidence[${index}]`)
  const id = nonEmptyString(item.id, `evidence[${index}].id`)
  const storedCaseId = nonEmptyString(item.case_id, `evidence[${index}].case_id`)
  if (storedCaseId !== caseId) validation(`evidence[${index}].case_id does not match its case`)
  return {
    id,
    case_id: storedCaseId,
    source: nonEmptyString(item.source, `evidence[${index}].source`),
    as_of: isoTimestamp(item.as_of, `evidence[${index}].as_of`),
    kind: enumValue(item.kind, `evidence[${index}].kind`, EVIDENCE_KINDS),
    content: nonEmptyString(item.content, `evidence[${index}].content`),
    created_at: isoTimestamp(item.created_at, `evidence[${index}].created_at`),
  }
}

function parseCase(value: unknown, index: number): InvestmentCase {
  const item = asObject(value, `cases[${index}]`)
  const id = nonEmptyString(item.id, `cases[${index}].id`)
  if (!Array.isArray(item.evidence)) validation(`cases[${index}].evidence must be an array`)
  return {
    id,
    code: nonEmptyString(item.code, `cases[${index}].code`),
    name: nonEmptyString(item.name, `cases[${index}].name`),
    horizon: enumValue(item.horizon, `cases[${index}].horizon`, HORIZONS),
    thesis: nonEmptyString(item.thesis, `cases[${index}].thesis`),
    catalysts: stringArray(item.catalysts, `cases[${index}].catalysts`),
    risks: stringArray(item.risks, `cases[${index}].risks`),
    invalidation: stringArray(item.invalidation, `cases[${index}].invalidation`),
    confidence: finiteRange(item.confidence, `cases[${index}].confidence`, 0, 1),
    status: enumValue(item.status, `cases[${index}].status`, CASE_STATUSES),
    review_at: isoTimestamp(item.review_at, `cases[${index}].review_at`),
    evidence: item.evidence.map((entry, evidenceIndex) => parseEvidence(entry, evidenceIndex, id)),
    created_at: isoTimestamp(item.created_at, `cases[${index}].created_at`),
    updated_at: isoTimestamp(item.updated_at, `cases[${index}].updated_at`),
  }
}

function parseCaseFile(value: unknown): CaseFile {
  const root = asObject(value, 'investment case state')
  if (root.version !== 1) validation('investment case state.version must be 1')
  if (!Array.isArray(root.cases)) validation('investment case state.cases must be an array')
  const cases = root.cases.map(parseCase)
  const caseIds = new Set<string>()
  const evidenceIds = new Set<string>()
  for (const item of cases) {
    if (caseIds.has(item.id)) validation(`duplicate investment case id: ${item.id}`)
    caseIds.add(item.id)
    for (const evidence of item.evidence) {
      if (evidenceIds.has(evidence.id)) validation(`duplicate evidence id: ${evidence.id}`)
      evidenceIds.add(evidence.id)
    }
  }
  return { version: 1, cases }
}

function parseCaseCreate(value: Record<string, unknown>): InvestmentCaseCreate {
  return {
    code: nonEmptyString(value.code, 'code'),
    name: nonEmptyString(value.name, 'name'),
    horizon: enumValue(value.horizon, 'horizon', HORIZONS),
    thesis: nonEmptyString(value.thesis, 'thesis'),
    catalysts: stringArray(value.catalysts, 'catalysts'),
    risks: stringArray(value.risks, 'risks'),
    invalidation: stringArray(value.invalidation, 'invalidation'),
    confidence: finiteRange(value.confidence, 'confidence', 0, 1),
    status: enumValue(value.status, 'status', CASE_STATUSES),
    review_at: isoTimestamp(value.review_at, 'review_at'),
  }
}

function parseCasePatch(value: Record<string, unknown>): Partial<InvestmentCaseCreate> {
  const patch: Partial<InvestmentCaseCreate> = {}
  if (value.code !== undefined) patch.code = nonEmptyString(value.code, 'code')
  if (value.name !== undefined) patch.name = nonEmptyString(value.name, 'name')
  if (value.horizon !== undefined) patch.horizon = enumValue(value.horizon, 'horizon', HORIZONS)
  if (value.thesis !== undefined) patch.thesis = nonEmptyString(value.thesis, 'thesis')
  if (value.catalysts !== undefined) patch.catalysts = stringArray(value.catalysts, 'catalysts')
  if (value.risks !== undefined) patch.risks = stringArray(value.risks, 'risks')
  if (value.invalidation !== undefined) patch.invalidation = stringArray(value.invalidation, 'invalidation')
  if (value.confidence !== undefined) patch.confidence = finiteRange(value.confidence, 'confidence', 0, 1)
  if (value.status !== undefined) patch.status = enumValue(value.status, 'status', CASE_STATUSES)
  if (value.review_at !== undefined) patch.review_at = isoTimestamp(value.review_at, 'review_at')
  if (Object.keys(patch).length === 0) validation('case update requires at least one mutable field')
  return patch
}

export class InvestmentCaseStore {
  private readonly path: string
  private readonly now: () => string
  private readonly id: (kind: 'case' | 'evidence' | 'decision') => string

  constructor(dataDir: string, deps: StoreDeps = {}) {
    this.path = join(dataDir, INVESTMENT_CASES_FILE)
    this.now = deps.now ?? (() => new Date().toISOString())
    this.id = deps.id ?? (kind => `${kind}-${randomUUID()}`)
  }

  private load(): CaseFile {
    if (!existsSync(this.path)) return { version: 1, cases: [] }
    try {
      return parseCaseFile(readJson(this.path, 'investment case state'))
    } catch (error) {
      if (error instanceof FinanceStateError && error.code === 'CORRUPT_STATE') throw error
      const detail = error instanceof Error ? error.message : String(error)
      throw new FinanceStateError(`investment case state is corrupt: ${detail}`, 'CORRUPT_STATE')
    }
  }

  private save(state: CaseFile): void {
    atomicWriteJsonSync(this.path, state, 2)
  }

  listCases(filter: { code?: string; status?: InvestmentCaseStatus } = {}): InvestmentCase[] {
    if (filter.status !== undefined) enumValue(filter.status, 'status', CASE_STATUSES)
    const code = filter.code?.trim()
    return clone(this.load().cases.filter(item =>
      (code === undefined || item.code === code)
      && (filter.status === undefined || item.status === filter.status)))
  }

  upsertCase(input: InvestmentCaseUpsert): InvestmentCase {
    const raw = asObject(input, 'case')
    const state = this.load()
    if (raw.id !== undefined) {
      const id = nonEmptyString(raw.id, 'id')
      const existing = state.cases.find(item => item.id === id)
      if (!existing) throw new FinanceStateError(`investment case not found: ${id}`, 'NOT_FOUND')
      const patch = parseCasePatch(raw)
      Object.assign(existing, patch)
      existing.updated_at = isoTimestamp(this.now(), 'updated_at')
      this.save(state)
      return clone(existing)
    }

    const parsed = parseCaseCreate(raw)
    const now = isoTimestamp(this.now(), 'created_at')
    const created: InvestmentCase = {
      id: nonEmptyString(this.id('case'), 'generated case id'),
      ...parsed,
      evidence: [],
      created_at: now,
      updated_at: now,
    }
    state.cases.push(created)
    this.save(state)
    return clone(created)
  }

  appendEvidence(caseId: string, input: EvidenceAppend): EvidenceEntry {
    const state = this.load()
    const target = state.cases.find(item => item.id === nonEmptyString(caseId, 'case_id'))
    if (!target) throw new FinanceStateError(`investment case not found: ${caseId}`, 'NOT_FOUND')
    const raw = asObject(input, 'evidence')
    const created: EvidenceEntry = {
      id: nonEmptyString(this.id('evidence'), 'generated evidence id'),
      case_id: target.id,
      source: nonEmptyString(raw.source, 'source'),
      as_of: isoTimestamp(raw.as_of, 'as_of'),
      kind: enumValue(raw.kind, 'kind', EVIDENCE_KINDS),
      content: nonEmptyString(raw.content, 'content'),
      created_at: isoTimestamp(this.now(), 'created_at'),
    }
    target.evidence.push(created)
    target.updated_at = created.created_at
    this.save(state)
    return clone(created)
  }
}

function parseDecision(value: unknown, index: number): DecisionEntry {
  const item = asObject(value, `entries[${index}]`)
  const caseId = optionalString(item.case_id, `entries[${index}].case_id`)
  const positionId = optionalString(item.position_id, `entries[${index}].position_id`)
  if (!caseId && !positionId) validation(`entries[${index}] requires case_id or position_id`)
  return {
    id: nonEmptyString(item.id, `entries[${index}].id`),
    action: enumValue(item.action, `entries[${index}].action`, DECISION_ACTIONS),
    rationale: nonEmptyString(item.rationale, `entries[${index}].rationale`),
    case_id: caseId,
    position_id: positionId,
    expected_outcome: nonEmptyString(item.expected_outcome, `entries[${index}].expected_outcome`),
    invalidation: nonEmptyString(item.invalidation, `entries[${index}].invalidation`),
    evidence_ids: stringArray(item.evidence_ids, `entries[${index}].evidence_ids`),
    timestamp: isoTimestamp(item.timestamp, `entries[${index}].timestamp`),
  }
}

function parseDecisionFile(value: unknown): DecisionFile {
  const root = asObject(value, 'decision journal state')
  if (root.version !== 1) validation('decision journal state.version must be 1')
  if (!Array.isArray(root.entries)) validation('decision journal state.entries must be an array')
  const entries = root.entries.map(parseDecision)
  const ids = new Set<string>()
  for (const entry of entries) {
    if (ids.has(entry.id)) validation(`duplicate decision id: ${entry.id}`)
    ids.add(entry.id)
  }
  return { version: 1, entries }
}

export class DecisionJournalStore {
  private readonly path: string
  private readonly now: () => string
  private readonly id: (kind: 'case' | 'evidence' | 'decision') => string

  constructor(dataDir: string, deps: StoreDeps = {}) {
    this.path = join(dataDir, DECISION_JOURNAL_FILE)
    this.now = deps.now ?? (() => new Date().toISOString())
    this.id = deps.id ?? (kind => `${kind}-${randomUUID()}`)
  }

  private load(): DecisionFile {
    if (!existsSync(this.path)) return { version: 1, entries: [] }
    try {
      return parseDecisionFile(readJson(this.path, 'decision journal state'))
    } catch (error) {
      if (error instanceof FinanceStateError && error.code === 'CORRUPT_STATE') throw error
      const detail = error instanceof Error ? error.message : String(error)
      throw new FinanceStateError(`decision journal state is corrupt: ${detail}`, 'CORRUPT_STATE')
    }
  }

  private save(state: DecisionFile): void {
    atomicWriteJsonSync(this.path, state, 2)
  }

  list(filter: { case_id?: string; position_id?: string } = {}): DecisionEntry[] {
    return clone(this.load().entries.filter(item =>
      (filter.case_id === undefined || item.case_id === filter.case_id)
      && (filter.position_id === undefined || item.position_id === filter.position_id)))
  }

  record(input: DecisionRecord): DecisionEntry {
    const raw = asObject(input, 'decision')
    const caseId = optionalString(raw.case_id, 'case_id')
    const positionId = optionalString(raw.position_id, 'position_id')
    if (!caseId && !positionId) validation('decision requires case_id or position_id')
    const state = this.load()
    const entry: DecisionEntry = {
      id: nonEmptyString(this.id('decision'), 'generated decision id'),
      action: enumValue(raw.action, 'action', DECISION_ACTIONS),
      rationale: nonEmptyString(raw.rationale, 'rationale'),
      case_id: caseId,
      position_id: positionId,
      expected_outcome: nonEmptyString(raw.expected_outcome, 'expected_outcome'),
      invalidation: nonEmptyString(raw.invalidation, 'invalidation'),
      evidence_ids: stringArray(raw.evidence_ids, 'evidence_ids'),
      timestamp: isoTimestamp(this.now(), 'timestamp'),
    }
    state.entries.push(entry)
    this.save(state)
    return clone(entry)
  }
}

export const INVESTMENT_HORIZONS: readonly InvestmentHorizon[] = HORIZONS
export const INVESTMENT_CASE_STATUSES: readonly InvestmentCaseStatus[] = CASE_STATUSES
export const INVESTMENT_EVIDENCE_KINDS: readonly EvidenceKind[] = EVIDENCE_KINDS
export const INVESTMENT_DECISION_ACTIONS: readonly DecisionAction[] = DECISION_ACTIONS
