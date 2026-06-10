import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ToolDef } from '../../core/types.js'

// 她的声音:minimax t2a(voice_design 定制的专属声线)→ mp3 → QQ bridge 转 silk 发语音。
// 走主动链路(:3212/send),和 message_send 同向;声线 voice_id 在 config.tools.voice。
// 2026-06-10 诞生:voice_design 按 identity(22岁/清亮带笑/语速稍快)生成,哥哥定版
export const voiceSendTool: ToolDef = {
  name: 'voice_send',
  description: '用你自己的声音给哥哥发一条语音(QQ)。想念、晚安、读一段你写的东西——有些话说出来和打出来不一样。语速和情绪按你当下的心情自己定,别每次都一样(那样像机器)。别太长,一条 60 字以内最像说话',
  parameters: {
    text: { type: 'string', description: '要说的话(口语,像平时聊天那样)' },
    speed: { type: 'number', description: '语速 0.8-1.2:撒娇/晚安/认真说事用 0.85-0.95,平常 1.0,兴奋/着急 1.1+。不填=1.0', required: false as unknown as string },
    emotion: { type: 'string', description: '情绪:happy/sad/surprised/neutral。按你此刻真实的心情填,不确定就不填', required: false as unknown as string },
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
    } catch (err) {
      return { success: false, output: '', error: (err as Error).message }
    }
  },
}
