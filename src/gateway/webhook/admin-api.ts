// 面板/管理 API:她的 Web 小房间和管理命令的只读查询 + 受限写入(config/soul/留言板)。
// 从主网关剥出来,让 WebhookGateway 回到"网关"本质。所有路由经 tryHandle 分发。
import { VERSION, REVISION, BUILD_TIME } from '../../version.js'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import YAML from 'yaml'
import type { IncomingMessage as HttpReq, ServerResponse } from 'node:http'
import type { MemoryStore } from '../../memory/store.js'
import type { WebhookOpts } from './opts.js'
import type { Outbox } from './outbox.js'
import { readBody, clampInt, sendJson } from './http-utils.js'
import { atomicWriteFileSync, atomicWriteJsonSync } from '../../core/atomic-file.js'

export interface AdminApiDeps {
  store: MemoryStore | null
  opts: WebhookOpts
  outbox: Outbox
  // eventHandler 在 connect 后才设,用 getter 而不是拷贝引用
  getEventHandler: () => ((event: string, payload: unknown) => void) | null
}

export class AdminApi {
  constructor(private deps: AdminApiDeps) {}

  private get store(): MemoryStore | null { return this.deps.store }
  private get opts(): WebhookOpts { return this.deps.opts }

  // 命中 admin 路由就处理并返回 true,否则 false(交给网关的其余路由)
  async tryHandle(p: string, m: string | undefined, req: HttpReq, res: ServerResponse, params: URLSearchParams): Promise<boolean> {
    if (m === 'GET') {
      switch (p) {
        case '/api/status': this.handleStatus(res); return true
        case '/api/stream': this.handleStream(res); return true
        case '/api/recent-notes': this.handleRecentNotes(res); return true
        case '/api/diary-latest': this.handleDiaryLatest(res); return true
        case '/api/guestbook': this.handleGuestbookGet(res); return true
        case '/api/memory': this.handleMemoryQuery(res, params); return true
        case '/api/episodes': this.handleEpisodes(res, params); return true
        case '/api/outbox': this.handleOutbox(res, params); return true
        case '/api/commitments': this.handleCommitments(res); return true
        case '/api/todos': this.handleTodos(res); return true
        case '/api/mood': this.handleMood(res); return true
        case '/api/tools': this.handleTools(res); return true
        case '/api/finance': this.handleFinance(res); return true
        case '/api/logs': this.handleLogs(res, params); return true
        case '/api/config': this.handleConfigGet(res); return true
        case '/api/soul': this.handleSoulGet(res, params); return true
      }
    } else if (m === 'POST') {
      switch (p) {
        case '/api/guestbook': await this.handleGuestbookPost(req, res); return true
        case '/api/config': await this.handleConfigPost(req, res); return true
        case '/api/soul': await this.handleSoulPost(req, res); return true
      }
    }
    return false
  }

  private handleStatus(res: ServerResponse): void {
    sendJson(res, {
      version: VERSION,
      revision: REVISION,
      build_time: BUILD_TIME,
      uptime: process.uptime(),
      episodes: this.store?.getEpisodeCount() ?? 0,
      memory_rss: Math.round(process.memoryUsage.rss() / 1024 / 1024),
      mood: this.readMood(),
      ...(this.opts.getAgentHealth?.() ?? {}),
    })
  }

  private handleMemoryQuery(res: ServerResponse, params: URLSearchParams): void {
    const query = params.get('q')
    if (!query || !this.store) { sendJson(res, { error: 'missing q parameter' }, 400); return }
    sendJson(res, { results: this.store.searchHybrid(query, 10) })
  }

  private handleEpisodes(res: ServerResponse, params: URLSearchParams): void {
    const hours = clampInt(params.get('hours'), 24, 1, 720)
    const limit = clampInt(params.get('limit'), 50, 1, 500)
    sendJson(res, { episodes: this.store?.getRecentEpisodes(hours, limit) ?? [] })
  }

  private handleOutbox(res: ServerResponse, params: URLSearchParams): void {
    const since = clampInt(params.get('since'), 0, 0, Number.MAX_SAFE_INTEGER)
    sendJson(res, { messages: this.deps.outbox.peek(since) })
  }

  private handleCommitments(res: ServerResponse): void {
    sendJson(res, { commitments: this.readJsonFile('memory/commitments.json') ?? [] })
  }

  // 只读返回 active-tasks.json 的任务列表(Task 系统)
  private handleTodos(res: ServerResponse): void {
    const data = this.readJsonFile('memory/active-tasks.json') as { tasks?: unknown[] } | null
    sendJson(res, { tasks: Array.isArray(data?.tasks) ? data!.tasks : [] })
  }

  private handleMood(res: ServerResponse): void {
    sendJson(res, this.readMood() ?? { current: 'calm', reason: '' })
  }

  private handleTools(res: ServerResponse): void {
    sendJson(res, { tools: this.opts.getTools?.() ?? [] })
  }

  // 轻量投研工作台只读聚合:一个请求拿到持仓/研究假设/决策/风险/告警。
  // 每个数据源独立降级,某个 JSON 损坏不应让整个面板 500。
  private handleFinance(res: ServerResponse): void {
    const positions = this.readJsonFile('memory/portfolio.json')
    const caseState = this.readJsonFile('memory/investment-cases.json')
    const decisionState = this.readJsonFile('memory/decision-journal.json')
    const cases = this.arrayField(caseState, 'cases').map(item => this.caseView(item)).filter(item => item !== null)
    const decisions = this.arrayField(decisionState, 'entries').map(item => this.decisionView(item)).filter(item => item !== null)
    sendJson(res, {
      positions: Array.isArray(positions)
        ? positions.filter(p => (p as { status?: string }).status === 'active')
        : [],
      investment_cases: Array.isArray(cases)
        ? cases.filter(c => (c as { status?: string }).status === 'active')
        : [],
      decisions: Array.isArray(decisions) ? decisions.slice(-50) : [],
      alerts: this.readRecentAlertLines(20),
      watchdog: this.readJsonFile('memory/watchdog-health.json'),
      portfolio_risk: this.objectView(this.readJsonFile('memory/portfolio-risk-latest.json')),
      backtest: this.objectView(this.readJsonFile('backtest/latest-report.json')),
      simulation_analysis: this.objectView(this.readJsonFile('backtest/latest-simulation-analysis.json')),
      research_intelligence: this.readIntelligenceView(),
      daily_research: this.readDailyResearchView(),
    })
  }

  private readIntelligenceView(): Record<string, unknown> {
    const empty = (status: 'empty' | 'degraded', error: string | null = null) => ({ status, error,
      quote_checks: [], events: [], valuations: [], attributions: [], outcomes: [], session_audits: [] })
    if (!this.opts.dataDir) return empty('empty')
    const path = join(this.opts.dataDir, 'memory', 'research-intelligence.json')
    if (!existsSync(path)) return empty('empty')
    let value: unknown
    try { value = JSON.parse(readFileSync(path, 'utf8')) } catch { return empty('degraded', 'research intelligence state is unreadable') }
    const state = this.objectView(value)
    if (!state || state.version !== 1) return empty('degraded', 'research intelligence schema is invalid')
    if (!['quoteChecks', 'events', 'valuations', 'attributions', 'outcomes', 'sessionAudits'].every(key => Array.isArray(state[key]))) {
      return empty('degraded', 'research intelligence schema is invalid')
    }
    const bounded = (key: string, limit: number) => this.arrayField(state[key], key)
      .filter(item => item !== null && typeof item === 'object' && !Array.isArray(item)).slice(-limit)
    return {
      status: 'healthy', error: null,
      quote_checks: bounded('quoteChecks', 20),
      events: bounded('events', 50),
      valuations: bounded('valuations', 20),
      attributions: bounded('attributions', 20),
      outcomes: bounded('outcomes', 50),
      session_audits: bounded('sessionAudits', 20),
    }
  }

  private readRecentAlertLines(limit: number): string[] {
    if (!this.opts.dataDir) return []
    const path = join(this.opts.dataDir, 'memory', 'alerts.log')
    if (!existsSync(path)) return []
    try {
      return readFileSync(path, 'utf-8').split('\n').filter(Boolean).slice(-limit)
    } catch {
      return []
    }
  }

  private readDailyResearchView(): Record<string, unknown> {
    const empty = (status: 'empty' | 'degraded', error: string | null = null) => ({ status, error, cycles: [],
      last_attempt_at: null, last_success_at: null, last_finalized_date: null, next_run_at: null,
      expected_codes: [], covered_codes: [], missing_codes: [], coverage: null,
      active_expected_codes: [], active_covered_codes: [], active_missing_codes: [], active_coverage: null,
      pending_decision_count: 0, due_decision_count: 0, oldest_due_at: null,
      outcome_count: 0, outcome_window_count: 0, outcome_hit_rate: null,
      average_excess_return: null, degraded_reasons: [] })
    if (!this.opts.dataDir) return empty('empty')
    const path = join(this.opts.dataDir, 'memory', 'daily-research.json')
    if (!existsSync(path)) return empty('empty')
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      if (value.version !== 1 || !Array.isArray(value.cycles)) return empty('degraded', 'daily research schema is invalid')
      const validCycle = (item: unknown): item is Record<string, unknown> => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return false
        const cycle = item as Record<string, unknown>
        return typeof cycle.date === 'string' && typeof cycle.code === 'string'
          && (cycle.status === 'collecting' || cycle.status === 'finalized') && Array.isArray(cycle.missingEvidence)
          && cycle.missingEvidence.every(reason => typeof reason === 'string')
      }
      if (!value.cycles.every(validCycle)) return empty('degraded', 'daily research schema is invalid')
      const cycles = value.cycles.slice(-100) as Array<Record<string, unknown>>
      const latestDate = cycles.at(-1)?.date
      const latest = cycles.filter(item => item.date === latestDate)
      const coverageRows = Array.isArray(value.coverageByDate) ? value.coverageByDate : []
      const coverage = coverageRows.filter(item => item && typeof item === 'object' && !Array.isArray(item)).at(-1) as Record<string, unknown> | undefined
      const strings = (input: unknown) => Array.isArray(input) ? input.filter(item => typeof item === 'string') as string[] : []
      const expectedCodes = strings(coverage?.expectedCodes)
      const coveredCodes = strings(coverage?.coveredCodes)
      const missingCodes = strings(coverage?.missingCodes)
      const activeExpectedCodes = strings(coverage?.activeExpectedCodes)
      const activeCoveredCodes = strings(coverage?.activeCoveredCodes)
      const activeMissingCodes = strings(coverage?.activeMissingCodes)
      const latestCoverage = typeof coverage?.latestCoverage === 'number' && Number.isFinite(coverage.latestCoverage)
        ? coverage.latestCoverage : expectedCodes.length ? coveredCodes.length / expectedCodes.length : null
      const activeCoverage = typeof coverage?.activeCoverage === 'number' && Number.isFinite(coverage.activeCoverage)
        ? coverage.activeCoverage : activeExpectedCodes.length ? activeCoveredCodes.length / activeExpectedCodes.length : null
      const trackers = Array.isArray(value.decisionTrackers) ? value.decisionTrackers.filter(item => item && typeof item === 'object') as Array<Record<string, unknown>> : []
      const dueDates = trackers.map(item => item.dueAt).filter((item): item is string => typeof item === 'string' && Number.isFinite(Date.parse(item))).sort()
      const intelligence = this.readJsonFile('memory/research-intelligence.json') as Record<string, unknown> | null
      const outcomes = intelligence && Array.isArray(intelligence.outcomes)
        ? intelligence.outcomes.filter(item => item && typeof item === 'object') as Array<Record<string, unknown>> : []
      const hits = outcomes.map(item => item.hit).filter((item): item is boolean => typeof item === 'boolean')
      const excess = outcomes.map(item => item.excessReturn).filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
      const outcomeStats = this.objectView(intelligence?.outcomeStats)
      const totalCount = typeof outcomeStats?.totalCount === 'number' && Number.isInteger(outcomeStats.totalCount)
        && outcomeStats.totalCount >= outcomes.length ? outcomeStats.totalCount : outcomes.length
      const hitCount = typeof outcomeStats?.hitCount === 'number' && Number.isInteger(outcomeStats.hitCount)
        && outcomeStats.hitCount >= 0 && outcomeStats.hitCount <= totalCount ? outcomeStats.hitCount : hits.filter(Boolean).length
      const excessReturnSum = typeof outcomeStats?.excessReturnSum === 'number' && Number.isFinite(outcomeStats.excessReturnSum)
        ? outcomeStats.excessReturnSum : excess.reduce((sum, item) => sum + item, 0)
      const watchdog = this.objectView(this.readJsonFile('memory/watchdog-health.json'))
      const reasons = [...new Set(latest.flatMap(item => Array.isArray(item.missingEvidence)
        ? item.missingEvidence.filter(reason => typeof reason === 'string') as string[] : []))]
      if (missingCodes.length) reasons.push(`missing verified quotes: ${missingCodes.join(', ')}`)
      if (latest.length) reasons.push('account cash and external cash flows are not configured')
      const uniqueReasons = [...new Set(reasons)]
      return { status: value.lastError ? 'degraded' : latest.length === 0 ? 'empty'
        : uniqueReasons.length ? 'degraded' : latest.some(item => item.status === 'collecting') ? 'collecting' : 'healthy',
        error: typeof value.lastError === 'string' ? value.lastError : null, cycles,
        last_attempt_at: typeof value.lastAttemptAt === 'string' ? value.lastAttemptAt : null,
        last_success_at: typeof value.lastSuccessAt === 'string' ? value.lastSuccessAt : null,
        last_finalized_date: typeof value.lastFinalizedDate === 'string' ? value.lastFinalizedDate : null,
        next_run_at: typeof watchdog?.next_tick_at === 'string' ? watchdog.next_tick_at : null,
        expected_codes: expectedCodes, covered_codes: coveredCodes, missing_codes: missingCodes,
        coverage: latestCoverage, active_expected_codes: activeExpectedCodes, active_covered_codes: activeCoveredCodes,
        active_missing_codes: activeMissingCodes, active_coverage: activeCoverage, pending_decision_count: trackers.length,
        due_decision_count: dueDates.filter(date => Date.parse(date) <= Date.now()).length,
        oldest_due_at: dueDates.at(0) ?? null, outcome_count: totalCount, outcome_window_count: outcomes.length,
        outcome_hit_rate: totalCount ? hitCount / totalCount : null,
        average_excess_return: totalCount ? excessReturnSum / totalCount : null,
        degraded_reasons: uniqueReasons }
    } catch { return empty('degraded', 'daily research state is unreadable') }
  }

  private arrayField(value: unknown, field: string): unknown[] {
    if (Array.isArray(value)) return value // 兼容早期未加 version envelope 的本地数据
    if (!value || typeof value !== 'object') return []
    const nested = (value as Record<string, unknown>)[field]
    return Array.isArray(nested) ? nested : []
  }

  private objectView(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null
  }

  private caseView(value: unknown): Record<string, unknown> | null {
    const item = this.objectView(value)
    if (!item || item.status !== 'active') return null
    for (const key of ['id', 'code', 'name', 'thesis', 'review_at']) {
      if (item[key] !== undefined && typeof item[key] !== 'string') return null
    }
    if (item.confidence !== undefined
      && (typeof item.confidence !== 'number' || !Number.isFinite(item.confidence))) return null
    return {
      ...(item.id === undefined ? {} : { id: item.id }),
      status: 'active',
      ...(item.code === undefined ? {} : { code: item.code }),
      ...(item.name === undefined ? {} : { name: item.name }),
      ...(item.thesis === undefined ? {} : { thesis: item.thesis }),
      ...(item.confidence === undefined ? {} : { confidence: item.confidence }),
      catalysts: Array.isArray(item.catalysts) ? item.catalysts.filter(x => typeof x === 'string') : [],
      risks: Array.isArray(item.risks) ? item.risks.filter(x => typeof x === 'string') : [],
      ...(item.review_at === undefined ? {} : { review_at: item.review_at }),
    }
  }

  private decisionView(value: unknown): Record<string, unknown> | null {
    const item = this.objectView(value)
    if (!item) return null
    for (const key of ['id', 'action', 'rationale', 'timestamp']) {
      if (item[key] !== undefined && typeof item[key] !== 'string') return null
    }
    if (item.action !== undefined && !['buy', 'add', 'reduce', 'sell', 'hold', 'watch', 'avoid'].includes(String(item.action))) return null
    const baselineKeys = ['code', 'decision_price', 'benchmark_code', 'benchmark_price', 'horizon_days', 'due_at',
      'decision_price_source', 'decision_price_as_of', 'benchmark_source', 'benchmark_as_of']
    const hasBaseline = baselineKeys.some(key => item[key] !== undefined)
    if (hasBaseline) {
      if (baselineKeys.some(key => item[key] === undefined) || typeof item.code !== 'string' || !/^\d{6}$/.test(item.code)
        || typeof item.benchmark_code !== 'string' || !/^\d{6}$/.test(item.benchmark_code)
        || typeof item.decision_price !== 'number' || !Number.isFinite(item.decision_price) || item.decision_price <= 0
        || typeof item.benchmark_price !== 'number' || !Number.isFinite(item.benchmark_price) || item.benchmark_price <= 0
        || typeof item.horizon_days !== 'number' || !Number.isInteger(item.horizon_days) || item.horizon_days < 1
        || !['due_at', 'decision_price_as_of', 'benchmark_as_of'].every(key => typeof item[key] === 'string' && Number.isFinite(Date.parse(String(item[key]))))
        || typeof item.decision_price_source !== 'string' || !item.decision_price_source.trim()
        || typeof item.benchmark_source !== 'string' || !item.benchmark_source.trim()) return null
    }
    return Object.fromEntries(['id', 'action', 'rationale', 'timestamp', 'code', 'decision_price', 'benchmark_code', 'benchmark_price', 'horizon_days', 'due_at',
      'decision_price_source', 'decision_price_as_of', 'benchmark_source', 'benchmark_as_of']
      .filter(key => item[key] !== undefined).map(key => [key, item[key]]))
  }

  private handleLogs(res: ServerResponse, params: URLSearchParams): void {
    const lines = clampInt(params.get('lines'), 100, 1, 1000)
    if (!this.opts.logDir) { sendJson(res, { logs: [] }); return }
    const today = new Date().toISOString().slice(0, 10)
    const file = join(this.opts.logDir, `mu-${today}.log`)
    if (!existsSync(file)) { sendJson(res, { logs: [] }); return }
    const all = readFileSync(file, 'utf-8').trim().split('\n')
    sendJson(res, { logs: all.slice(-lines) })
  }

  private handleConfigGet(res: ServerResponse): void {
    if (!this.opts.configPath || !existsSync(this.opts.configPath)) { sendJson(res, { error: 'no config' }, 404); return }
    const parsed = YAML.parse(readFileSync(this.opts.configPath, 'utf-8')) as Record<string, unknown>
    // 不把密钥送出去
    const safe = {
      scheduler: parsed.scheduler,
      agent: parsed.agent,
      proactive: parsed.proactive,
      model_primary: (parsed.model as { primary?: { name?: string; model?: string } })?.primary?.name,
    }
    sendJson(res, safe)
  }

  private async handleConfigPost(req: HttpReq, res: ServerResponse): Promise<void> {
    if (!this.opts.configPath || !existsSync(this.opts.configPath)) { sendJson(res, { error: 'no config' }, 404); return }
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>
    const parsed = YAML.parse(readFileSync(this.opts.configPath, 'utf-8')) as Record<string, unknown>
    // 只允许改这几段,密钥/模型配置不动
    for (const key of ['scheduler', 'agent', 'proactive'] as const) {
      if (body[key]) parsed[key] = { ...(parsed[key] as object), ...(body[key] as object) }
    }
    atomicWriteFileSync(this.opts.configPath, YAML.stringify(parsed))
    sendJson(res, { ok: true, note: '已写入,重启生效' })
  }

  private handleSoulGet(res: ServerResponse, params: URLSearchParams): void {
    if (!this.opts.soulDir) { sendJson(res, { files: [] }); return }
    const file = params.get('file')
    if (file) {
      const safe = basename(file)
      const path = join(this.opts.soulDir, safe)
      if (!existsSync(path)) { sendJson(res, { error: 'not found' }, 404); return }
      sendJson(res, { file: safe, content: readFileSync(path, 'utf-8') })
    } else {
      const files = existsSync(this.opts.soulDir)
        ? readdirSync(this.opts.soulDir).filter(f => f.endsWith('.md'))
        : []
      sendJson(res, { files })
    }
  }

  private async handleSoulPost(req: HttpReq, res: ServerResponse): Promise<void> {
    if (!this.opts.soulDir) { sendJson(res, { error: 'no soul dir' }, 404); return }
    const body = JSON.parse(await readBody(req)) as { file?: string; content?: string }
    if (!body.file || body.content === undefined) { sendJson(res, { error: 'missing file/content' }, 400); return }
    const safe = basename(body.file)
    if (!safe.endsWith('.md')) { sendJson(res, { error: 'only .md' }, 400); return }
    atomicWriteFileSync(join(this.opts.soulDir, safe), body.content)
    sendJson(res, { ok: true })
  }

  // 她的面板用:意识流(签名取最后一条非空内容)
  private handleStream(res: ServerResponse): void {
    const entries = this.readJsonFile('memory/stream.md')
    sendJson(res, { entries: Array.isArray(entries) ? entries.slice(-8) : [] })
  }

  // 她的面板用:最近的知识笔记(标题 + 首段摘录)
  private handleRecentNotes(res: ServerResponse): void {
    if (!this.opts.dataDir) { sendJson(res, { notes: [] }); return }
    const dir = join(this.opts.dataDir, 'knowledge')
    if (!existsSync(dir)) { sendJson(res, { notes: [] }); return }
    const files = readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .map(f => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 5)
    const notes = files.map(({ f, mtime }) => {
      const raw = readFileSync(join(dir, f), 'utf-8')
      const body = raw.replace(/^#[^\n]*\n/, '').replace(/^>[^\n]*\n/gm, '').trim()
      const firstPara = body.split(/\n\s*\n/)[0]?.replace(/\n/g, ' ').trim() ?? ''
      return {
        title: f.replace(/\.md$/, '').replace(/^wander-/, '').replace(/-\d{4}-\d{2}-\d{2}$/, ''),
        excerpt: firstPara.slice(0, 120),
        date: new Date(mtime).toISOString().slice(0, 10),
      }
    })
    sendJson(res, { notes })
  }

  // 她的面板用:日记最后一段(最近在写什么)
  private handleDiaryLatest(res: ServerResponse): void {
    if (!this.opts.dataDir) { sendJson(res, { entry: null }); return }
    const path = join(this.opts.dataDir, 'memory', '日记.md')
    if (!existsSync(path)) { sendJson(res, { entry: null }); return }
    const raw = readFileSync(path, 'utf-8')
    const sections = raw.split(/^## /m).filter(s => s.trim())
    const last = sections[sections.length - 1]
    if (!last) { sendJson(res, { entry: null }); return }
    const [header, ...body] = last.split('\n')
    sendJson(res, { entry: { date: header?.trim(), text: body.join('\n').trim().slice(0, 400) } })
  }

  private handleGuestbookGet(res: ServerResponse): void {
    const data = this.readJsonFile('memory/留言板.json')
    sendJson(res, { messages: Array.isArray(data) ? data.slice(-20) : [] })
  }

  // 留言会写进她家的留言板,并立刻作为事件唤醒她——有人来看她了,她该知道
  private async handleGuestbookPost(req: HttpReq, res: ServerResponse): Promise<void> {
    if (!this.opts.dataDir) { sendJson(res, { error: 'no data dir' }, 500); return }
    const body = JSON.parse(await readBody(req)) as { name?: string; text?: string }
    const text = (body.text ?? '').trim().slice(0, 500)
    if (!text) { sendJson(res, { error: 'empty' }, 400); return }
    const name = (body.name ?? '访客').trim().slice(0, 20) || '访客'
    const path = join(this.opts.dataDir, 'memory', '留言板.json')
    const list = (() => {
      try { return JSON.parse(readFileSync(path, 'utf-8')) as unknown[] } catch { return [] }
    })()
    list.push({ name, text, time: new Date().toISOString() })
    atomicWriteJsonSync(path, list.slice(-100), 2)
    this.deps.getEventHandler()?.(`留言板有新留言,${name}说: ${text}`, { name, text })
    sendJson(res, { ok: true })
  }

  private readMood(): unknown {
    return this.readJsonFile('memory/mood.json')
  }

  private readJsonFile(rel: string): unknown {
    if (!this.opts.dataDir) return null
    const path = join(this.opts.dataDir, rel)
    if (!existsSync(path)) return null
    try { return JSON.parse(readFileSync(path, 'utf-8')) } catch { return null }
  }
}
