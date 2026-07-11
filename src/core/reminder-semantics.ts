import { beijingDateStr, beijingWeekday, isTradingDay, type TradeCalendar } from './market-hours.js'

export interface ReminderSemanticIssue {
  code: 'invalid_target' | 'weekday_mismatch' | 'month_day_mismatch' | 'time_mismatch' | 'not_trading_day'
  message: string
}

export interface ReminderSemantics {
  targetAt: string
  expectedWeekday?: number
  requireTradingDay?: boolean
}

export function validateReminderSemantics(
  value: ReminderSemantics,
  calendar: TradeCalendar | null = null,
): { valid: boolean; beijingLocal: string | null; issues: ReminderSemanticIssue[] } {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value.targetAt)) {
    const issues: ReminderSemanticIssue[] = [{ code: 'invalid_target', message: 'target_at 必须包含明确时区(Z或±HH:MM)' }]
    return { valid: false, beijingLocal: null, issues }
  }
  const target = new Date(value.targetAt)
  if (!Number.isFinite(target.getTime())) {
    const issues: ReminderSemanticIssue[] = [{ code: 'invalid_target', message: 'target_at 必须是合法 ISO 时间' }]
    return { valid: false, beijingLocal: null, issues }
  }
  const issues: ReminderSemanticIssue[] = []
  const weekday = beijingWeekday(target)
  if (value.expectedWeekday !== undefined && value.expectedWeekday !== weekday) {
    issues.push({ code: 'weekday_mismatch', message: `目标是周${weekdayText(weekday)},不是周${weekdayText(value.expectedWeekday)}` })
  }
  if (value.requireTradingDay && !isTradingDay(target, calendar)) {
    issues.push({ code: 'not_trading_day', message: `${beijingDateStr(target)} 不是交易日` })
  }
  return { valid: issues.length === 0, beijingLocal: beijingLocal(target), issues }
}

export function auditReminderText(
  at: string,
  reason: string,
  calendar: TradeCalendar | null = null,
): { valid: boolean; beijingLocal: string | null; issues: ReminderSemanticIssue[] } {
  const base = validateReminderSemantics({ targetAt: at }, calendar)
  if (!base.beijingLocal) return base
  const target = new Date(at)
  const issues = [...base.issues]
  const weekdayMatch = reason.match(/周([日天一二三四五六])/)
  const dateMatch = reason.match(/(?:^|\D)(\d{1,2})\s*[月/]\s*(\d{1,2})(?:\s*日)?/)
  const timeMatches = [...reason.matchAll(/(?:^|\D)([01]?\d|2[0-3]):([0-5]\d)(?:\D|$)/g)]
  const shifted = new Date(target.getTime() + 8 * 3600_000)
  const actualWeekday = shifted.getUTCDay()
  const weekdayMap: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 }
  const textWeekday = weekdayMatch ? (weekdayMap[weekdayMatch[1]!] ?? -1) : -1
  const mentionedDate = dateMatch
    ? new Date(Date.UTC(shifted.getUTCFullYear(), Number(dateMatch[1]) - 1, Number(dateMatch[2]), 0, 0, 0))
    : null
  if (textWeekday >= 0) {
    const referenceWeekday = mentionedDate?.getUTCDay() ?? actualWeekday
    if (textWeekday !== referenceWeekday) {
      issues.push({ code: 'weekday_mismatch', message: '提醒文字中的星期与所写日期不一致' })
    }
  }
  if (dateMatch && (Number(dateMatch[1]) !== shifted.getUTCMonth() + 1 || Number(dateMatch[2]) !== shifted.getUTCDate())) {
    issues.push({ code: 'month_day_mismatch', message: '提醒文字中的月日与实际唤醒时间不一致' })
  }
  const timeMatch = timeMatches.at(-1)
  if (timeMatch && (Number(timeMatch[1]) !== shifted.getUTCHours() || Number(timeMatch[2]) !== shifted.getUTCMinutes())) {
    issues.push({ code: 'time_mismatch', message: '提醒文字中的时分与实际唤醒时间不一致' })
  }
  return { valid: issues.length === 0, beijingLocal: base.beijingLocal, issues }
}

function beijingLocal(date: Date): string {
  const shifted = new Date(date.getTime() + 8 * 3600_000)
  const hh = String(shifted.getUTCHours()).padStart(2, '0')
  const mm = String(shifted.getUTCMinutes()).padStart(2, '0')
  return `${beijingDateStr(date)} ${hh}:${mm}`
}

function weekdayText(value: number): string {
  return ['日', '一', '二', '三', '四', '五', '六'][value] ?? '?'
}
