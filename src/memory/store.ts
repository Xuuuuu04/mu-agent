import Database from 'better-sqlite3'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface EpisodeRow {
  id: string
  timestamp: string
  source: string
  role: string | null
  content: string
  summary: string | null
  embedding: Buffer | null
  session_id: string | null
  topic_tags: string | null
  entities: string | null
  is_consolidated: number
}

export interface DailySummaryRow {
  date: string
  summary: string
  key_facts: string | null
  mood_trajectory: string | null
}

export class MemoryStore {
  private db: Database.Database

  constructor(dbPath: string) {
    const dir = dirname(dbPath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS episodes (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        source TEXT NOT NULL,
        role TEXT,
        content TEXT NOT NULL,
        summary TEXT,
        embedding BLOB,
        session_id TEXT,
        topic_tags TEXT,
        entities TEXT,
        is_consolidated INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_episodes_timestamp ON episodes(timestamp);
      CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(session_id);
      CREATE INDEX IF NOT EXISTS idx_episodes_source ON episodes(source);

      CREATE TABLE IF NOT EXISTS daily_summaries (
        date TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        key_facts TEXT,
        mood_trajectory TEXT
      );

      CREATE TABLE IF NOT EXISTS schedule_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        wake_type TEXT NOT NULL,
        reason TEXT,
        next_wake_seconds INTEGER,
        actual_wake TEXT
      );

      CREATE TABLE IF NOT EXISTS token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        model TEXT,
        trigger_type TEXT,
        duration_ms INTEGER
      );
    `)

    const ftsExists = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='episodes_fts'"
    ).get()

    if (!ftsExists) {
      this.db.exec(`
        CREATE VIRTUAL TABLE episodes_fts USING fts5(
          content, summary, topic_tags, entities,
          content='episodes',
          content_rowid='rowid',
          tokenize='unicode61'
        );
      `)
    }

    // FTS5 外部内容表：用 trigger 与 episodes 严格同步。否则 INSERT OR REPLACE / DELETE
    // 会留下孤儿索引行，rowid 被复用后旧关键词错配到新记忆(已删内容"借尸还魂")。
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS episodes_ai AFTER INSERT ON episodes BEGIN
        INSERT INTO episodes_fts(rowid, content, summary, topic_tags, entities)
        VALUES (new.rowid, new.content, new.summary, new.topic_tags, new.entities);
      END;
      CREATE TRIGGER IF NOT EXISTS episodes_ad AFTER DELETE ON episodes BEGIN
        INSERT INTO episodes_fts(episodes_fts, rowid, content, summary, topic_tags, entities)
        VALUES ('delete', old.rowid, old.content, old.summary, old.topic_tags, old.entities);
      END;
      CREATE TRIGGER IF NOT EXISTS episodes_au AFTER UPDATE ON episodes BEGIN
        INSERT INTO episodes_fts(episodes_fts, rowid, content, summary, topic_tags, entities)
        VALUES ('delete', old.rowid, old.content, old.summary, old.topic_tags, old.entities);
        INSERT INTO episodes_fts(rowid, content, summary, topic_tags, entities)
        VALUES (new.rowid, new.content, new.summary, new.topic_tags, new.entities);
      END;
    `)
  }

  insertEpisode(ep: Omit<EpisodeRow, 'is_consolidated'>): void {
    // FTS 同步由 episodes_ai/ad/au trigger 负责，这里只写主表
    this.db.prepare(`
      INSERT OR REPLACE INTO episodes (id, timestamp, source, role, content, summary, embedding, session_id, topic_tags, entities, is_consolidated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(ep.id, ep.timestamp, ep.source, ep.role, ep.content, ep.summary, ep.embedding, ep.session_id, ep.topic_tags, ep.entities)
  }

  searchFTS(query: string, limit = 10): EpisodeRow[] {
    return this.db.prepare(`
      SELECT e.* FROM episodes e
      JOIN episodes_fts f ON e.rowid = f.rowid
      WHERE episodes_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(query, limit) as EpisodeRow[]
  }

  // LIKE 子串匹配。FTS5 unicode61 对中文是整段切词,"深圳"这种子串搜不到,用 LIKE 兜底。
  // term 里的 %/_ 要转义,否则 "100%" 这种查询会变成通配符乱匹配
  searchLike(term: string, limit = 10): EpisodeRow[] {
    const escaped = term.replace(/[\\%_]/g, c => `\\${c}`)
    return this.db.prepare(`
      SELECT * FROM episodes WHERE content LIKE ? ESCAPE '\\' ORDER BY timestamp DESC LIMIT ?
    `).all(`%${escaped}%`, limit) as EpisodeRow[]
  }

  // FTS 优先,不够再 LIKE 补,按 id 去重。中文检索的主力
  searchHybrid(query: string, limit = 10): EpisodeRow[] {
    const seen = new Set<string>()
    const out: EpisodeRow[] = []
    try {
      for (const r of this.searchFTS(`"${query}"`, limit)) {
        if (!seen.has(r.id)) { seen.add(r.id); out.push(r) }
      }
    } catch (e) {
      // FTS 语法错(query 带特殊字符)是预期的，静默降级 LIKE；其余(如 SQLITE_CORRUPT)记一笔再降级
      const msg = (e as Error).message
      if (!/fts5|syntax|unterminated|malformed|no such/i.test(msg)) {
        console.error(`[store] searchFTS 异常(疑似真故障): ${msg}`)
      }
    }
    if (out.length < limit) {
      for (const r of this.searchLike(query, limit)) {
        if (!seen.has(r.id)) { seen.add(r.id); out.push(r) }
        if (out.length >= limit) break
      }
    }
    return out
  }

  getRecentEpisodes(hours = 24, limit = 50): EpisodeRow[] {
    const since = new Date(Date.now() - hours * 3600_000).toISOString()
    return this.db.prepare(`
      SELECT * FROM episodes WHERE timestamp > ? ORDER BY timestamp DESC LIMIT ?
    `).all(since, limit) as EpisodeRow[]
  }

  getEpisodesByTimeRange(from: string, to: string, limit = 20): EpisodeRow[] {
    return this.db.prepare(`
      SELECT * FROM episodes WHERE timestamp BETWEEN ? AND ? ORDER BY timestamp DESC LIMIT ?
    `).all(from, to, limit) as EpisodeRow[]
  }

  getEpisodesByEntity(entity: string, limit = 10): EpisodeRow[] {
    return this.db.prepare(`
      SELECT * FROM episodes WHERE entities LIKE ? ORDER BY timestamp DESC LIMIT ?
    `).all(`%${entity}%`, limit) as EpisodeRow[]
  }

  updateEmbedding(id: string, embedding: Buffer): void {
    this.db.prepare('UPDATE episodes SET embedding = ? WHERE id = ?').run(embedding, id)
  }

  // 有 embedding 的记忆,语义检索时全量加载做暴力 cosine(个人规模够用)
  getEpisodesWithEmbedding(limit = 2000): EpisodeRow[] {
    return this.db.prepare(`
      SELECT * FROM episodes WHERE embedding IS NOT NULL ORDER BY timestamp DESC LIMIT ?
    `).all(limit) as EpisodeRow[]
  }

  // 还没算 embedding 的记忆,后台补算用
  getEpisodesNeedingEmbedding(limit = 50): EpisodeRow[] {
    return this.db.prepare(`
      SELECT * FROM episodes WHERE embedding IS NULL ORDER BY timestamp DESC LIMIT ?
    `).all(limit) as EpisodeRow[]
  }

  // 历史记忆里出现过的实体,当作实体检索的词典
  getKnownEntities(limit = 200): string[] {
    const rows = this.db.prepare(`
      SELECT entities FROM episodes WHERE entities IS NOT NULL AND entities != '[]' LIMIT ?
    `).all(limit) as Array<{ entities: string }>
    const set = new Set<string>()
    for (const r of rows) {
      try {
        for (const e of JSON.parse(r.entities) as string[]) set.add(e)
      } catch { /* skip */ }
    }
    return [...set]
  }

  getUnconsolidated(limit = 100): EpisodeRow[] {
    return this.db.prepare(`
      SELECT * FROM episodes WHERE is_consolidated = 0 ORDER BY timestamp ASC LIMIT ?
    `).all(limit) as EpisodeRow[]
  }

  markConsolidated(ids: string[]): void {
    const stmt = this.db.prepare('UPDATE episodes SET is_consolidated = 1 WHERE id = ?')
    const tx = this.db.transaction((ids: string[]) => {
      for (const id of ids) stmt.run(id)
    })
    tx(ids)
  }

  upsertDailySummary(row: DailySummaryRow): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO daily_summaries (date, summary, key_facts, mood_trajectory)
      VALUES (?, ?, ?, ?)
    `).run(row.date, row.summary, row.key_facts, row.mood_trajectory)
  }

  getDailySummary(date: string): DailySummaryRow | undefined {
    return this.db.prepare('SELECT * FROM daily_summaries WHERE date = ?').get(date) as DailySummaryRow | undefined
  }

  getRecentDailySummaries(days = 7): DailySummaryRow[] {
    return this.db.prepare(`
      SELECT * FROM daily_summaries ORDER BY date DESC LIMIT ?
    `).all(days) as DailySummaryRow[]
  }

  // 今天(UTC)烧了多少 token,/status 显示用
  getTodayTokenUsage(): { input: number; output: number; calls: number } {
    const today = new Date().toISOString().slice(0, 10)
    return this.db.prepare(`
      SELECT COALESCE(SUM(input_tokens),0) as input, COALESCE(SUM(output_tokens),0) as output, COUNT(*) as calls
      FROM token_usage WHERE timestamp >= ?
    `).get(today) as { input: number; output: number; calls: number }
  }

  logTokenUsage(data: { input: number; output: number; cache_read: number; model: string; trigger: string; duration: number }): void {
    this.db.prepare(`
      INSERT INTO token_usage (timestamp, input_tokens, output_tokens, cache_read_tokens, model, trigger_type, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(new Date().toISOString(), data.input, data.output, data.cache_read, data.model, data.trigger, data.duration)
  }

  logSchedule(data: { wake_type: string; reason: string; next_wake_seconds?: number }): void {
    this.db.prepare(`
      INSERT INTO schedule_log (timestamp, wake_type, reason, next_wake_seconds)
      VALUES (?, ?, ?, ?)
    `).run(new Date().toISOString(), data.wake_type, data.reason, data.next_wake_seconds ?? null)
  }

  getEpisodeCount(): number {
    return (this.db.prepare('SELECT COUNT(*) as cnt FROM episodes').get() as { cnt: number }).cnt
  }

  pruneOldEpisodes(olderThanDays = 30): number {
    const cutoff = new Date(Date.now() - olderThanDays * 86400_000).toISOString()
    const result = this.db.prepare(`
      DELETE FROM episodes WHERE timestamp < ? AND is_consolidated = 1 AND summary IS NOT NULL
    `).run(cutoff)
    return result.changes
  }

  close(): void {
    this.db.close()
  }
}
