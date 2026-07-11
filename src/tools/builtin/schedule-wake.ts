import type { ToolDef } from '../../core/types.js'
import { validateReminderSemantics, type ReminderSemantics } from '../../core/reminder-semantics.js'

// 安排定时唤醒,用于给用户做定时提醒。到点 scheduler 唤醒,助理再用 message_send 发提醒。
// 实际秒数会被 scheduler 按深夜规则 clamp。
export const scheduleWakeTool: ToolDef = {
  name: 'schedule_wake',
  description: '安排在指定秒数后唤醒自己,用于给用户做定时提醒。用户说"X 之后提醒我做某事"时用;到点你会以这个原因被唤醒,那时再用 message_send 把提醒发给用户',
  parameters: {
    seconds: { type: 'number', description: '多少秒后唤醒;与 target_at 二选一', required: false },
    target_at: { type: 'string', description: '绝对目标时间 ISO 8601;日期型提醒优先使用', required: false },
    expected_weekday: { type: 'number', description: '预期北京时间星期:0周日,1周一...6周六', required: false },
    require_trading_day: { type: 'boolean', description: '是否必须为 A 股交易日', required: false },
    reason: { type: 'string', description: '到点唤醒的原因(到时你会看到它,据此提醒用户)' },
    activity_type: {
      type: 'string',
      description: '可选标签,默认 reminder(用户提醒,绝不被来消息打断丢失);task=自主任务续推进;rest=可被消息打断的自主休息',
      required: false as unknown as string,
    },
  },
  async execute(params, ctx) {
    let semantics: ReminderSemantics | undefined
    let seconds: number
    if (params.target_at !== undefined) {
      const expected = params.expected_weekday
      if (expected !== undefined && (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0 || expected > 6)) {
        return { success: false, output: '', error: 'expected_weekday 必须是 0-6 的整数' }
      }
      if (params.require_trading_day !== undefined && typeof params.require_trading_day !== 'boolean') {
        return { success: false, output: '', error: 'require_trading_day 必须是布尔值' }
      }
      semantics = {
        targetAt: String(params.target_at),
        ...(expected === undefined ? {} : { expectedWeekday: expected }),
        ...(params.require_trading_day === undefined ? {} : { requireTradingDay: params.require_trading_day }),
      }
      const validation = validateReminderSemantics(semantics)
      if (!validation.valid) return { success: false, output: '', error: validation.issues.map(x => x.message).join(';') }
      seconds = Math.ceil((Date.parse(semantics.targetAt) - Date.now()) / 1000)
    } else {
      seconds = Number(params.seconds)
    }
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return { success: false, output: '', error: '秒数不合法' }
    }
    if (!ctx.scheduleWake) {
      return { success: false, output: '', error: '调度器不可用' }
    }
    const reason = String(params.reason ?? '')
    // 默认 reminder:这个工具的本职是“给用户做定时提醒”,漏传 activity_type 时绝不能落成
    // 可被来消息打断的 rest(那样提醒会被静默丢掉)。自主 task 续唤醒由 scheduleTaskContinuation 显式传 task。
    const activity = String(params.activity_type ?? 'reminder')
    try {
      ctx.scheduleWake(seconds, reason, activity, semantics)
    } catch (error) {
      return { success: false, output: '', error: error instanceof Error ? error.message : String(error) }
    }
    ctx.log(`定了 ${seconds}秒后醒: ${reason}`)
    return { success: true, output: `好,${seconds}秒后醒来` }
  },
}
