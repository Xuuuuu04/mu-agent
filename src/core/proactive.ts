import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { MuConfig, WakeTrigger, Commitment } from './types.js'
import { loadMood } from '../memory/layers/mood.js'

export interface QuietConfig { quietStart: number; quietEnd: number; maxPerHour: number }

// 主动通信的频率保护决策(纯函数,可单测)。深夜不打扰(跨午夜判断对齐 scheduler.clamp)、
// 每小时上限(滑窗 1h)、连续 3 条没回降频。返回决策 + 剪枝后的 sentLog(quiet 时不剪)。
export function decideCanSend(
  now: number, sentLog: number[], unrepliedStreak: number, c: QuietConfig,
): { ok: boolean; prunedLog: number[] } {
  const hour = new Date(now).getHours()
  const inQuiet = c.quietStart < c.quietEnd
    ? (hour >= c.quietStart && hour < c.quietEnd)
    : (hour >= c.quietStart || hour < c.quietEnd)
  if (inQuiet) return { ok: false, prunedLog: sentLog }

  const prunedLog = sentLog.filter(t => t > now - 3600_000)
  if (prunedLog.length >= c.maxPerHour) return { ok: false, prunedLog }
  if (unrepliedStreak >= 3) return { ok: false, prunedLog }
  return { ok: true, prunedLog }
}

// 本地日期(YYYY-MM-DD)。承诺的 due 是模型按本地时间锚点填的，比较必须用本地日期而非 UTC
function localDateStr(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// F8 主动通信。定期评估"该不该主动找哥哥",满足触发条件且没超频率就发起一次 cycle。
// 真正发什么由 agent 在 cycle 里决定(它能看到触发原因),这里只管"要不要叫醒她去说"。
export class ProactiveManager {
  private config: MuConfig
  private dataDir: string
  private fire: ((trigger: WakeTrigger) => void) | null = null
  private timer: ReturnType<typeof setInterval> | null = null

  private sentLog: number[] = []           // 主动消息时间戳,算每小时频率
  private lastContactAt = Date.now()       // 上次哥哥说话
  private unrepliedStreak = 0              // 连续主动未回复次数
  private lastMissingDay = ''             // 想念触发当天计数
  private missingCountToday = 0
  private lastTriggerHadMissing = false    // 本次触发是否含"想念",决定 recordSent 是否计入想念配额
  private firedDay = ''                    // 承诺触发去重:同一承诺每天最多唤醒一次
  private firedCommitments = new Set<string>()
  private stateFile: string                // 频率/计数落盘，扛 pm2 重启

  constructor(config: MuConfig, dataDir: string) {
    this.config = config
    this.dataDir = dataDir
    this.stateFile = join(dataDir, 'memory', 'proactive-state.json')
  }

  setTrigger(fn: (trigger: WakeTrigger) => void): void {
    this.fire = fn
  }

  start(): void {
    if (!this.config.proactive?.enabled) return
    this.loadState()
    // 每 10 分钟评估一次
    this.timer = setInterval(() => this.evaluate(), 10 * 60 * 1000)
    console.log('[proactive] 主动通信已开启')
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  // 哥哥回消息了:重置未回复计数,更新联系时间
  onUserMessage(): void {
    this.lastContactAt = Date.now()
    this.unrepliedStreak = 0
    this.saveState()
  }

  // 一条主动消息发出去了
  recordSent(): void {
    this.sentLog.push(Date.now())
    this.unrepliedStreak++
    // 想念配额只统计"想念触发"的发送；承诺到期/自决唤醒触发的发送不该吃想念配额
    if (this.lastTriggerHadMissing) {
      const today = localDateStr()
      if (this.lastMissingDay !== today) { this.lastMissingDay = today; this.missingCountToday = 0 }
      this.missingCountToday++
      this.lastTriggerHadMissing = false
    }
    this.saveState()
  }

  private evaluate(): void {
    if (!this.fire) return
    const reasons = this.collectReasons()
    if (reasons.length === 0) return
    if (!this.canSendNow()) return

    // 记下这次触发是否含想念，recordSent 时据此决定要不要计入想念配额
    this.lastTriggerHadMissing = reasons.some(r => r.startsWith('想哥哥了'))

    // 本次触发涉及的承诺记下来,今天不再为同一条反复唤醒
    // (06-09 事故:5 条过期 active 承诺让 evaluate 每 10 分钟扣一次扳机)
    const today = localDateStr()
    if (this.firedDay !== today) { this.firedDay = today; this.firedCommitments.clear() }
    for (const r of reasons) {
      if (r.startsWith('承诺到期: ')) this.firedCommitments.add(r.slice('承诺到期: '.length))
    }
    this.saveState()

    this.fire({ type: 'system_event', event: `主动通信触发: ${reasons.join('; ')}` })
  }

  private collectReasons(): string[] {
    const reasons: string[] = []
    const now = Date.now()

    // 想念:心情 missing 且超过 2 小时没联系,每天最多 3 次
    const mood = loadMood(this.dataDir)
    const hoursSinceContact = (now - this.lastContactAt) / 3600_000
    const today = localDateStr()
    const missingToday = this.lastMissingDay === today ? this.missingCountToday : 0
    if (mood?.current === 'missing' && hoursSinceContact > 2 && missingToday < 3) {
      reasons.push(`想哥哥了(${Math.floor(hoursSinceContact)}小时没说话)`)
    }

    // 承诺到期:今天该做、还没做的
    for (const c of this.dueCommitments()) {
      reasons.push(`承诺到期: ${c}`)
    }

    return reasons
  }

  private dueCommitments(): string[] {
    const path = join(this.dataDir, 'memory', 'commitments.json')
    if (!existsSync(path)) return []
    try {
      const commitments = JSON.parse(readFileSync(path, 'utf-8')) as Commitment[]
      const now = new Date()
      const todayStr = localDateStr(now)
      const today = this.firedDay === todayStr ? this.firedCommitments : new Set<string>()
      const out: string[] = []
      for (const c of commitments) {
        if (c.status !== 'active') continue
        if (today.has(c.content)) continue  // 今天已为它唤醒过
        if (c.type === 'one-time' && c.due) {
          // 过期超 2 天还没做的不再催(没人标 done 的烂尾承诺会永远挂着,
          // 06-09 就是 5 条这种让 proactive 无限扣扳机);它仍会出现在
          // temporal 的待办提醒里("已过期X天!"),留给沐自己清理
          const overdueDays = (now.getTime() - new Date(c.due).getTime()) / 86400_000
          if (c.due <= todayStr && overdueDays <= 2) out.push(c.content)
        } else if (c.type === 'recurring') {
          // 今天还没做过就提醒(粗略判断:last_done 不是今天)
          const lastDoneDay = c.last_done?.slice(0, 10)
          if (lastDoneDay !== todayStr) out.push(c.content)
        }
      }
      return out.slice(0, 3)
    } catch {
      return []
    }
  }

  private canSendNow(): boolean {
    const { ok, prunedLog } = decideCanSend(Date.now(), this.sentLog, this.unrepliedStreak, {
      quietStart: this.config.proactive?.quiet_start_hour ?? 1,
      quietEnd: this.config.proactive?.quiet_end_hour ?? 8,
      maxPerHour: this.config.proactive?.max_per_hour ?? 5,
    })
    this.sentLog = prunedLog
    return ok
  }

  private loadState(): void {
    if (!existsSync(this.stateFile)) return
    try {
      const s = JSON.parse(readFileSync(this.stateFile, 'utf-8'))
      this.sentLog = Array.isArray(s.sentLog) ? s.sentLog : []
      this.lastContactAt = typeof s.lastContactAt === 'number' ? s.lastContactAt : Date.now()
      this.unrepliedStreak = s.unrepliedStreak ?? 0
      this.lastMissingDay = s.lastMissingDay ?? ''
      this.missingCountToday = s.missingCountToday ?? 0
      this.firedDay = s.firedDay ?? ''
      this.firedCommitments = new Set(Array.isArray(s.firedCommitments) ? s.firedCommitments : [])
    } catch { /* 状态文件坏了就当全新开始 */ }
  }

  private saveState(): void {
    try {
      writeFileSync(this.stateFile, JSON.stringify({
        sentLog: this.sentLog,
        lastContactAt: this.lastContactAt,
        unrepliedStreak: this.unrepliedStreak,
        lastMissingDay: this.lastMissingDay,
        missingCountToday: this.missingCountToday,
        firedDay: this.firedDay,
        firedCommitments: [...this.firedCommitments],
      }))
    } catch { /* 落盘失败不影响主流程 */ }
  }
}
