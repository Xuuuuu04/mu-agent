import type { ToolDef } from '../../core/types.js'

// 用工具调用设置下次唤醒,比在文本里写 [WAKE:...] 更可靠。
// 实际秒数会被 scheduler 按心情/深夜规则 clamp。
export const scheduleWakeTool: ToolDef = {
  name: 'schedule_wake',
  description: '决定自己多久后醒来继续做事。看完书想消化、想等会再找哥哥时用',
  parameters: {
    seconds: { type: 'number', description: '多少秒后醒来' },
    reason: { type: 'string', description: '为什么这个时间醒(给未来的自己看)' },
    activity_type: {
      type: 'string',
      description: '醒来想做什么: learning/browsing/writing/task/rest/explore',
      required: false as unknown as string,
    },
  },
  async execute(params, ctx) {
    const seconds = Number(params.seconds)
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return { success: false, output: '', error: '秒数不合法' }
    }
    if (!ctx.scheduleWake) {
      return { success: false, output: '', error: '调度器不可用' }
    }
    const reason = String(params.reason ?? '')
    const activity = String(params.activity_type ?? 'rest')
    ctx.scheduleWake(seconds, reason, activity)
    ctx.log(`定了 ${seconds}秒后醒: ${reason}`)
    return { success: true, output: `好,${seconds}秒后醒来` }
  },
}
