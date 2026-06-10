import type { ToolDef } from '../../core/types.js'
import { extractEntities } from '../../memory/entities.js'

// 同一内容 60 秒去重,防止 glitch 刷屏
const recentSends = new Map<string, number>()

export const messageSendTool: ToolDef = {
  name: 'message_send',
  description: '主动给哥哥发一条消息。想他了、有事要说、提醒他什么时用。一次只发一条。可以带一张图片(本地路径,比如你的画、截图)',
  parameters: {
    text: { type: 'string', description: '要发的话' },
    image_path: { type: 'string', description: '要发的图片的本地路径(可选,png/jpg)', required: false as unknown as string },
  },
  async execute(params, ctx) {
    const text = String(params.text ?? '').trim()
    const imagePath = String(params.image_path ?? '').trim() || undefined
    if (!text && !imagePath) return { success: false, output: '', error: '消息为空' }

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
