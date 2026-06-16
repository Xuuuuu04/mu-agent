// 消息队列:串行处理 WakeTrigger,合并同 sender 连发,跑 cycle,按来源+同步窗口分发回复。
// 结构化注入依赖(loop/webhook/cli/scheduler/deliverToUser),便于单测。
import type { WakeTrigger, CycleResult, OutgoingMessage } from '../core/types.js'
import { guardStyle } from '../soul/style-guard.js'
import { log } from '../core/logger.js'
import { describeTrigger } from './trigger-format.js'

export interface QueueDeps {
  loop: { runCycle: (t: WakeTrigger) => Promise<CycleResult> }
  webhook: { hasPending: (id: string) => boolean; send: (msg: OutgoingMessage) => Promise<void> }
  cli: { send: (msg: OutgoingMessage) => Promise<void> }
  scheduler: { getStatus: () => { sleeping: boolean; nextWake: Date | null; reason: string } }
  deliverToUser: (text: string, imagePath?: string) => Promise<void>
}

export class MessageQueue {
  private queue: WakeTrigger[] = []
  private processing = false

  constructor(private deps: QueueDeps) {}

  push(trigger: WakeTrigger): void {
    this.queue.push(trigger)
    void this.process()
  }

  // 哥哥连发的几条消息合并进一个 cycle,避免逐条全量回应(重逢戏码三连发的预防针)。
  // 被合并的消息立刻回空响应,释放 bridge 的同步等待(不然它干等 110s)。
  private async mergeQueuedMessages(trigger: WakeTrigger): Promise<void> {
    if (trigger.type !== 'message' || trigger.message.content.type !== 'text') return
    const extra: string[] = []
    while (this.queue.length > 0) {
      const next = this.queue[0]!
      if (next.type !== 'message'
        || next.message.sender.id !== trigger.message.sender.id
        || next.message.content.type !== 'text') break
      this.queue.shift()
      extra.push(next.message.content.text)
      if (next.message.source === 'webhook') {
        await this.deps.webhook.send({
          target: { source: 'webhook', chat_id: next.message.sender.id },
          content: [{ type: 'text', text: '' }],
          reply_to: next.message.id,
        })
      }
    }
    if (extra.length > 0) {
      trigger.message.content.text += '\n' + extra.join('\n')
      console.log(`  [queue] 合并了 ${extra.length} 条连发消息`)
    }
  }

  private async process(): Promise<void> {
    if (this.processing || this.queue.length === 0) return
    this.processing = true

    const trigger = this.queue.shift()!
    try {
      await this.mergeQueuedMessages(trigger)
      // 开始就打一行:GLM cycle 动辄几分钟,没有这行的话,跑着的 cycle 在日志里是隐形的
      // (06-10 上午她醒来跑了 10+ 分钟,外面只能靠猜)
      console.log(`[cycle] 开始 (${trigger.type}) ${describeTrigger(trigger)}`)
      const result = await this.deps.loop.runCycle(trigger)

      // 只有"消息触发"的 cycle 才把回复发给用户(这是在回他的话)。
      // 自主唤醒/主动触发的 cycle,回复是内心活动,只进意识流/记忆;要找哥哥得 agent 自己调 message_send。
      if (result.response && trigger.type === 'message') {
        const { cleaned, issues } = guardStyle(result.response)
        if (issues.length > 0) {
          const fixed = issues.filter(i => i.fixed).length
          if (fixed > 0) console.log(`  [style] 修正了 ${fixed} 个风格问题`)
        }
        const outMsg = {
          target: { source: trigger.message.source, chat_id: trigger.message.sender.id },
          content: [{ type: 'text' as const, text: cleaned }],
          reply_to: trigger.message.id,
        }

        if (trigger.message.source === 'webhook') {
          if (this.deps.webhook.hasPending(trigger.message.id)) {
            await this.deps.webhook.send(outMsg)
          } else {
            // GLM 跑太久,bridge 的同步窗口(110s)已经关了——回复转 QQ 主动推,
            // 不能让她说的话消失(之前这条路径只有一行注释,没有实现,回复会蒸发)
            console.log('  [deliver] 同步窗口已过,回复转主动推送')
            await this.deps.deliverToUser(cleaned)
          }
        } else {
          await this.deps.cli.send(outMsg)
        }
      } else if (result.response) {
        // 自主 cycle 的内心独白,dev 下打印看看
        console.log(`  [内心] ${result.response.slice(0, 60)}`)
      } else if (trigger.type === 'message') {
        // 回复为空(reasoning 吃光 token/只调了工具/清洗后空):仍要释放同步等待的 bridge,
        // 否则它干等 110s 表现成"已读不回"。发空文本即可,bridge 端 if not reply 会自行忽略。
        const src = trigger.message.source
        const emptyMsg = {
          target: { source: src, chat_id: trigger.message.sender.id },
          content: [{ type: 'text' as const, text: '' }],
          reply_to: trigger.message.id,
        }
        if (src === 'webhook') await this.deps.webhook.send(emptyMsg)
      }

      const tok = result.tokens_used
      const cache = tok.cache_read ? ` cache:${tok.cache_read}` : ''
      // 来源摘要必须进日志:06-10 上午 12 条匿名空 cycle 查了半天才定位到是谁发的
      const who = describeTrigger(trigger)
      log.info('cycle', `${tok.input}+${tok.output}tok${cache} ${result.tool_calls_made}tools ${result.duration_ms}ms | ${who}`, {
        trigger: trigger.type, who, input: tok.input, output: tok.output, cache_read: tok.cache_read ?? 0,
        tools: result.tool_calls_made, ms: result.duration_ms,
      })

      const schedStatus = this.deps.scheduler.getStatus()
      if (schedStatus.sleeping && schedStatus.nextWake) {
        const secs = Math.round((schedStatus.nextWake.getTime() - Date.now()) / 1000)
        console.log(`  [scheduler] 下次醒来: ${secs}秒后 (${schedStatus.reason})`)
      }
    } catch (err) {
      log.error('cycle', (err as Error).message, { trigger: trigger.type })
    } finally {
      this.processing = false
      if (this.queue.length > 0) void this.process()
    }
  }
}
