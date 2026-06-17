import { writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolDef } from '../../core/types.js'

// 她的画笔:ComfyUI(本地 xpark GB10,:8188)SDXL txt2img → png → 她用 message_send 配文字发。
// 照 voice_send 的模子(调外部服务生成媒体 → 发),底模默认 RealVisXL(写实萌,已验证 18s/张)。
// 提示词她自己给英文(ToolContext 无 LLM,且"她想画什么用英文说"更像她自己);质量词/负向词工具补。
const DEFAULT_HOST = 'http://127.0.0.1:8188'
const DEFAULT_CKPT = 'RealVisXL_V5.0_fp16.safetensors'
const QUALITY = 'masterpiece, best quality, highly detailed, soft natural lighting'
const NEGATIVE = 'worst quality, low quality, blurry, deformed, ugly, extra limbs, bad anatomy, text, watermark, signature'

// SDXL txt2img workflow(ComfyUI /prompt 的节点图)。纯函数,无副作用,便于单测。
// 节点连线对齐 ComfyUI 标准:Checkpoint→(CLIP 编码 pos/neg + KSampler)→VAEDecode→SaveImage。
export function buildWorkflow(
  prompt: string,
  opts: { seed: number; checkpoint: string; steps?: number },
): Record<string, unknown> {
  return {
    '3': { class_type: 'KSampler', inputs: { seed: opts.seed, steps: opts.steps ?? 25, cfg: 7, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: opts.checkpoint } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: `${prompt}, ${QUALITY}`, clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: NEGATIVE, clip: ['4', 1] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'mu_gen', images: ['8', 0] } },
  }
}

// 生成图只留最近 keep 张(文件名是 base36 时间戳,字典序≈时间序到 2059 年),防磁盘无限涨。
// 导出便于单测。删不掉的(被占用等)跳过,不影响主流程。
export function pruneOldImages(dir: string, keep: number): void {
  try {
    const pngs = readdirSync(dir).filter(f => f.endsWith('.png')).sort()
    for (const f of pngs.slice(0, Math.max(0, pngs.length - keep))) {
      try { unlinkSync(join(dir, f)) } catch { /* 删不掉算了 */ }
    }
  } catch { /* 目录读不了算了 */ }
}

export const imageGenTool: ToolDef = {
  name: 'image_gen',
  description: '画一张图给哥哥。心里有个画面、想画点什么送他的时候用——比翻表情包更自由,你想画啥就画啥。用英文关键词描述画面(主体+场景+光线/氛围),比如 "a fluffy cream-white kitten curled up on a warm windowsill, snow falling outside, cozy"。画完会给你图片路径,再用 message_send 的 image_path 配一句话发给他。一张约 20 秒',
  parameters: {
    prompt: { type: 'string', description: '画面描述,英文关键词:主体+场景+氛围/光线,越具体越好。质量词不用写(自动加)' },
    seed: { type: 'number', description: '随机种子(可选)。想在同一张基础上微调就固定它;不填每次都不一样', required: false as unknown as string },
  },
  async execute(params, ctx) {
    const prompt = String(params.prompt ?? '').trim()
    if (!prompt) return { success: false, output: '', error: '没说要画什么' }

    const imgCfg = ctx.config.tools?.image
    const host = (imgCfg?.host ?? DEFAULT_HOST).replace(/\/$/, '')
    const ckpt = imgCfg?.checkpoint ?? DEFAULT_CKPT
    const rawSeed = Number(params.seed)
    const seed = Number.isFinite(rawSeed) && rawSeed >= 0 ? Math.floor(rawSeed) : Math.floor(Math.random() * 1e9)

    try {
      const wf = buildWorkflow(prompt, { seed, checkpoint: ckpt })
      const submit = await fetch(`${host}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: wf }),
        signal: AbortSignal.timeout(15000),
      })
      if (!submit.ok) return { success: false, output: '', error: `ComfyUI 提交失败 HTTP ${submit.status}(画图服务没开?)` }
      const promptId = (await submit.json() as { prompt_id?: string }).prompt_id
      if (!promptId) return { success: false, output: '', error: 'ComfyUI 没返回 prompt_id' }

      // 轮询 history 等出图(最多 120s,一张约 20s,留足余量)
      const t0 = Date.now()
      let img: { filename: string; subfolder: string } | null = null
      let failMsg = ''
      while (Date.now() - t0 < 120000) {
        await new Promise(r => setTimeout(r, 1500))
        const h = await fetch(`${host}/history/${promptId}`, { signal: AbortSignal.timeout(10000) }).catch(() => null)
        if (!h?.ok) continue
        const hist = await h.json() as Record<string, {
          status?: { status_str?: string; completed?: boolean }
          outputs?: Record<string, { images?: Array<{ filename: string; subfolder: string }> }>
        }>
        const entry = hist[promptId]
        if (!entry) continue
        // 服务端报错就提前退出,别空转到 120s 假超时(reviewer #3)
        if (entry.status?.status_str === 'error') { failMsg = 'ComfyUI 生成失败(服务端报错,可能提示词或参数有问题)'; break }
        if (entry.outputs) {
          for (const node of Object.values(entry.outputs)) {
            if (node.images?.length) { img = node.images[0]!; break }
          }
          if (img) break
          if (entry.status?.completed) { failMsg = 'ComfyUI 跑完了却没产出图'; break }
        }
      }
      if (!img) return { success: false, output: '', error: failMsg || '画了挺久没出来(120s 超时),可能太复杂或服务卡了' }

      // 从 ComfyUI /view 取图字节(标准端点,不硬编码 comfyui output 目录)
      const viewUrl = `${host}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder)}&type=output`
      const view = await fetch(viewUrl, { signal: AbortSignal.timeout(15000) })
      if (!view.ok) return { success: false, output: '', error: `取图失败 HTTP ${view.status}` }
      const buf = Buffer.from(await view.arrayBuffer())

      // 存 data/生成图/,返回相对路径(和表情包一个约定):message_send 会 resolveSafe 成绝对路径发
      const dir = join(ctx.dataDir, '生成图')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const fname = `${Date.now().toString(36)}.png`
      writeFileSync(join(dir, fname), buf)
      const relPath = `生成图/${fname}`
      pruneOldImages(dir, 50)   // 只留最近 50 张,防慢性磁盘泄漏(reviewer #4)

      ctx.log(`画好了: "${prompt.slice(0, 40)}" -> ${relPath} (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
      return { success: true, output: `画好了!图在 ${relPath}\n用 message_send 的 image_path 填这个路径,配一句话发给哥哥。` }
    } catch (err) {
      return { success: false, output: '', error: `画图出错: ${(err as Error).message}` }
    }
  },
}
