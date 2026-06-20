import { isAbsolute } from 'node:path'
import type { ToolDef } from '../../core/types.js'
import { extractEntities } from '../../memory/entities.js'
import { resolveSafe } from './file.js'

// 同一内容 60 秒去重,防止 glitch 刷屏
const recentSends = new Map<string, number>()

export const messageSendTool: ToolDef = {
  name: 'message_send',
  description: '主动给用户发一条消息。有事要告知、到点提醒用户时用。一次只发一条。可以带一张图片(本地路径,比如截图、生成的图)',
  parameters: {
    text: { type: 'string', description: '要发的内容' },
    image_path: { type: 'string', description: '要发的图片的本地路径(可选,png/jpg)', required: false as unknown as string },
    urgent: { type: 'boolean', description: '深夜/清晨的非紧急消息会被软拦一道;确有急事(用户让你叫他/紧急情况)填 true 直接发', required: false as unknown as string },
  },
  async execute(params, ctx) {
    const text = String(params.text ?? '').trim()
    const rawImagePath = String(params.image_path ?? '').trim() || undefined
    if (!text && !rawImagePath) return { success: false, output: '', error: '消息为空' }

    // image_path 规范化:她按"相对 data/"约定填(和 file 工具一致,如 表情包/x.png、生成图/x.png),
    // 转成 bridge 能 open 的绝对路径。06-17 修:bridge CWD 在 mu 根、直接 open(image),
    // 相对路径 "表情包/x.png" 会落到 mu 根而非 data/ 下 → 必 404。resolveSafe 顺带剥 data/ 前缀+防逃逸。
    let imagePath = rawImagePath
    if (rawImagePath) {
      const resolved = isAbsolute(rawImagePath) ? rawImagePath : resolveSafe(ctx.dataDir, rawImagePath)
      if (!resolved) return { success: false, output: '', error: `图片路径跑到 data 外面了: ${rawImagePath}` }
      imagePath = resolved
    }

    // 深夜 quiet 时段(随 proactive 配置,默认 1-8 点)的非紧急主动消息软拦一道,
    // 避免在用户睡觉时打扰。不硬禁:急事带 urgent 放行
    const hour = new Date().getHours()
    const qs = ctx.config.proactive?.quiet_start_hour ?? 1
    const qe = ctx.config.proactive?.quiet_end_hour ?? 8
    const inQuiet = qs < qe ? (hour >= qs && hour < qe) : (hour >= qs || hour < qe)
    if (inQuiet && params.urgent !== true) {
      return {
        success: false, output: '',
        error: `现在${hour}点,用户多半在睡。不是急事就先存着,等他醒了再发;确有急事重新调一次带 urgent: true`,
      }
    }

    const now = Date.now()
    const dedupeKey = text + (imagePath ?? '')
    const last = recentSends.get(dedupeKey)
    if (last && now - last < 60000) {
      return { success: false, output: '', error: '这条刚发过(60秒内去重)' }
    }

    if (!ctx.sendMessage) {
      return { success: false, output: '', error: '当前没有可用的发送通道' }
    }

    try {
      await ctx.sendMessage(text, imagePath)
      recentSends.set(dedupeKey, now)
      // 清理老记录
      for (const [k, t] of recentSends) if (now - t > 120000) recentSends.delete(k)
      // 主动说出去的话也要进记忆:之前只在会话历史的 tool_use 里,轮转后就没了——
      // 早报/提醒这些她自己发的消息,事后她检索不到("我早上跟你说了啥"答不上)
      if (text) {
        const entities = extractEntities(text)
        ctx.store?.insertEpisode({
          id: `ep_${now.toString(36)}_send`,
          timestamp: new Date(now).toISOString(),
          source: 'chat',
          role: 'assistant',
          content: `(主动发给用户) ${text}`.slice(0, 500),
          summary: null,
          embedding: null,
          session_id: null,
          topic_tags: null,
          entities: entities.length > 0 ? JSON.stringify(entities) : null,
        })
      }
      ctx.log(`发了: ${text.slice(0, 40)}`)
      return { success: true, output: '发出去了' }
    } catch (err) {
      return { success: false, output: '', error: (err as Error).message }
    }
  },
}
