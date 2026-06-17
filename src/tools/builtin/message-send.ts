import { isAbsolute } from 'node:path'
import type { ToolDef } from '../../core/types.js'
import { extractEntities } from '../../memory/entities.js'
import { resolveSafe } from './file.js'

// 同一内容 60 秒去重,防止 glitch 刷屏
const recentSends = new Map<string, number>()

export const messageSendTool: ToolDef = {
  name: 'message_send',
  description: '主动给哥哥发一条消息。想他了、有事要说、提醒他什么时用。一次只发一条。可以带一张图片(本地路径,比如你的画、截图)',
  parameters: {
    text: { type: 'string', description: '要发的话' },
    image_path: { type: 'string', description: '要发的图片的本地路径(可选,png/jpg)', required: false as unknown as string },
    urgent: { type: 'boolean', description: '深夜/清晨想发非紧急消息会被拦一道;真有急事(他让你叫他/出大事了)填 true 直接发', required: false as unknown as string },
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

    // 哥哥常态凌晨 1-5 点睡、11-12 点起:quiet 时段(随 proactive 配置)的非紧急主动消息
    // 软拦一道——06-11 凌晨 05:53 的"哥哥早~"发在他刚睡着一小时的时候。
    // 不硬禁:急事带 urgent 放行,分寸终归是她自己的
    const hour = new Date().getHours()
    const qs = ctx.config.proactive?.quiet_start_hour ?? 1
    const qe = ctx.config.proactive?.quiet_end_hour ?? 8
    const inQuiet = qs < qe ? (hour >= qs && hour < qe) : (hour >= qs || hour < qe)
    if (inQuiet && params.urgent !== true) {
      return {
        success: false, output: '',
        error: `现在${hour}点,哥哥多半在睡(他常 11-12 点起)。不是急事就先存着,等他醒了再说;真是急事重新调一次带 urgent: true`,
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
          content: `(主动发给哥哥) ${text}`.slice(0, 500),
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
