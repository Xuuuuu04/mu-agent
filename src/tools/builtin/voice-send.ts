import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ToolDef } from '../../core/types.js'

// 语音合成:minimax t2a → mp3 → QQ bridge 转 silk 发语音。
// 走主动链路(:3212/send),和 message_send 同向;声线 voice_id 在 config.tools.voice。
export const voiceSendTool: ToolDef = {
  name: 'voice_send',
  description: '把一段文字合成语音发给用户(QQ)。speed 语速、emotion 情绪可调。一条尽量短(60 字以内最自然)',
  parameters: {
    text: { type: 'string', description: '要合成的文字' },
    speed: { type: 'number', description: '语速 0.8-1.2,默认 1.0', required: false as unknown as string },
    emotion: { type: 'string', description: '情绪:happy/sad/surprised/neutral,可选', required: false as unknown as string },
  },
  async execute(params, ctx) {
    const text = String(params.text ?? '').trim()
    if (!text) return { success: false, output: '', error: '没有要说的话' }
    if (text.length > 200) return { success: false, output: '', error: '太长了,语音一条别超 200 字,拆开说' }

    const cfg = ctx.config.tools?.voice
    if (!cfg?.voice_id || !cfg.api_key) {
      return { success: false, output: '', error: '声音还没配置(tools.voice)' }
    }

    // 语速钳在 0.8-1.2:她自己按情绪定,出格的值拉回来
    const rawSpeed = Number(params.speed)
    const speed = Number.isFinite(rawSpeed) ? Math.max(0.8, Math.min(1.2, rawSpeed)) : (cfg.speed ?? 1.0)
    const emotion = ['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'neutral']
      .includes(String(params.emotion)) ? String(params.emotion) : undefined

    try {
      const base = (cfg.base_url || 'https://api.minimax.chat').replace(/\/$/, '')
      const resp = await fetch(`${base}/v1/t2a_v2`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.api_key}` },
        body: JSON.stringify({
          model: cfg.model || 'speech-2.6-hd',
          text,
          voice_setting: { voice_id: cfg.voice_id, speed, vol: 1, pitch: 0, ...(emotion ? { emotion } : {}) },
          audio_setting: { sample_rate: 24000, bitrate: 128000, format: 'mp3', channel: 1 },
        }),
        signal: AbortSignal.timeout(60000),
      })
      if (!resp.ok) return { success: false, output: '', error: `t2a HTTP ${resp.status}` }
      const data = await resp.json() as { data?: { audio?: string }; base_resp?: { status_msg?: string } }
      const hex = data.data?.audio
      if (!hex) return { success: false, output: '', error: `没生成音频: ${data.base_resp?.status_msg ?? '未知'}` }

      const mp3Path = join(tmpdir(), `mu-voice-${Date.now().toString(36)}.mp3`)
      writeFileSync(mp3Path, Buffer.from(hex, 'hex'))

      // bridge 在 HTTP 请求内同步读 mp3 转 silk,fetch 返回后就读完了 → 发完即删,别在 /tmp 无限堆积
      // (她长期跑在内存吃紧的小机上,image_gen 有 prune,这条以前没清理)。
      try {
        const sendUrl = ctx.config.qq?.bridge_send_url ?? 'http://127.0.0.1:3212/send'
        const sent = await fetch(sendUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ voice: mp3Path }),
          signal: AbortSignal.timeout(30000),
        })
        const sd = await sent.json().catch(() => ({})) as { ok?: boolean; error?: string }
        if (!sent.ok || !sd.ok) return { success: false, output: '', error: `语音发送失败: ${sd.error ?? sent.status}` }

        ctx.log(`发了语音: ${text.slice(0, 30)}`)
        return { success: true, output: '语音发出去了' }
      } finally {
        try { unlinkSync(mp3Path) } catch { /* 已被清理/不存在,忽略 */ }
      }
    } catch (err) {
      return { success: false, output: '', error: (err as Error).message }
    }
  },
}
