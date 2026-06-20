import type { ToolDef } from '../../core/types.js'

// 安排定时唤醒,用于给用户做定时提醒。到点 scheduler 唤醒,助理再用 message_send 发提醒。
// 实际秒数会被 scheduler 按深夜规则 clamp。
export const scheduleWakeTool: ToolDef = {
  name: 'schedule_wake',
  description: '安排在指定秒数后唤醒自己,用于给用户做定时提醒。用户说"X 之后提醒我做某事"时用;到点你会以这个原因被唤醒,那时再用 message_send 把提醒发给用户',
  parameters: {
    seconds: { type: 'number', description: '多少秒后唤醒' },
    reason: { type: 'string', description: '到点唤醒的原因(到时你会看到它,据此提醒用户)' },
    activity_type: {
      type: 'string',
      description: '可选标签: task/reminder 等',
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
