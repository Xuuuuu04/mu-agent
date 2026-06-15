// cycle 日志里的一句话来源:谁(渠道:发送者)说了什么 / 因为什么醒。纯函数。
import type { WakeTrigger } from '../core/types.js'

export function describeTrigger(trigger: WakeTrigger): string {
  switch (trigger.type) {
    case 'message': {
      const m = trigger.message
      const text = m.content.type === 'text' ? m.content.text : `[${m.content.type}]`
      return `${m.source}:${m.sender.id.slice(0, 8)} "${text.slice(0, 20)}"`
    }
    case 'self_scheduled': return `自醒:${trigger.reason.slice(0, 24)}`
    case 'cron_fallback': return `cron兜底:${trigger.reason.slice(0, 24)}`
    case 'system_event': return `事件:${trigger.event.slice(0, 24)}`
    case 'webhook': return `webhook:${trigger.source}`
    case 'manual': return `手动:${trigger.reason.slice(0, 24)}`
  }
}
