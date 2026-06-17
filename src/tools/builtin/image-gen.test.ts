import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildWorkflow, pruneOldImages, imageGenTool } from './image-gen.js'
import type { ToolContext } from '../../core/types.js'

// buildWorkflow 是纯函数:给提示词/seed/底模 → ComfyUI 节点图。锁住结构和连线,
// 改 workflow(换采样器/尺寸/加节点)前先看这里——节点 id 的引用关系错一个,ComfyUI 直接报错。

test('buildWorkflow: 9 个标准节点齐全', () => {
  const wf = buildWorkflow('a cat', { seed: 1, checkpoint: 'm.safetensors' })
  const types = Object.values(wf).map(n => (n as { class_type: string }).class_type)
  assert.ok(types.includes('KSampler'))
  assert.ok(types.includes('CheckpointLoaderSimple'))
  assert.ok(types.includes('EmptyLatentImage'))
  assert.equal(types.filter(t => t === 'CLIPTextEncode').length, 2) // 正向 + 负向
  assert.ok(types.includes('VAEDecode'))
  assert.ok(types.includes('SaveImage'))
})

test('buildWorkflow: 正向提示词拼了质量词,负向词独立', () => {
  const wf = buildWorkflow('a fluffy kitten', { seed: 1, checkpoint: 'm.safetensors' }) as Record<string, { inputs: { text?: string } }>
  const pos = wf['6']!.inputs.text!
  const neg = wf['7']!.inputs.text!
  assert.ok(pos.startsWith('a fluffy kitten'), '正向以她的提示词开头')
  assert.ok(pos.includes('best quality'), '自动补了质量词')
  assert.ok(neg.includes('worst quality'), '负向是质量排除词')
  assert.ok(!neg.includes('a fluffy kitten'), '负向不含她的提示词')
})

test('buildWorkflow: seed 和 checkpoint 正确注入', () => {
  const wf = buildWorkflow('x', { seed: 42, checkpoint: 'RealVisXL.safetensors' }) as Record<string, { inputs: Record<string, unknown> }>
  assert.equal(wf['3']!.inputs.seed, 42)
  assert.equal(wf['4']!.inputs.ckpt_name, 'RealVisXL.safetensors')
})

test('buildWorkflow: 节点连线正确(KSampler 引用 model/正向/负向/latent)', () => {
  const wf = buildWorkflow('x', { seed: 1, checkpoint: 'm.safetensors' }) as Record<string, { inputs: Record<string, unknown> }>
  const k = wf['3']!.inputs
  assert.deepEqual(k.model, ['4', 0])       // ← Checkpoint
  assert.deepEqual(k.positive, ['6', 0])    // ← 正向 CLIP
  assert.deepEqual(k.negative, ['7', 0])    // ← 负向 CLIP
  assert.deepEqual(k.latent_image, ['5', 0]) // ← EmptyLatent
  // CLIP 编码引用 checkpoint 的 clip 输出(索引 1)
  assert.deepEqual((wf['6']!.inputs as { clip: unknown }).clip, ['4', 1])
  // VAEDecode 引用 KSampler 的 latent(0)和 checkpoint 的 vae(2)
  assert.deepEqual((wf['8']!.inputs as { samples: unknown; vae: unknown }).samples, ['3', 0])
  assert.deepEqual((wf['8']!.inputs as { samples: unknown; vae: unknown }).vae, ['4', 2])
})

test('buildWorkflow: steps 可覆盖,默认 25', () => {
  assert.equal((buildWorkflow('x', { seed: 1, checkpoint: 'm' }) as Record<string, { inputs: { steps: number } }>)['3']!.inputs.steps, 25)
  assert.equal((buildWorkflow('x', { seed: 1, checkpoint: 'm', steps: 30 }) as Record<string, { inputs: { steps: number } }>)['3']!.inputs.steps, 30)
})

// ── pruneOldImages 防磁盘泄漏(reviewer #4)──

test('pruneOldImages: 超过 keep 张删最旧的(留字典序最大=最新)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mu-prune-'))
  try {
    for (const n of ['aaa', 'bbb', 'ccc', 'ddd']) writeFileSync(join(dir, `${n}.png`), 'x')
    pruneOldImages(dir, 2)
    assert.deepEqual(readdirSync(dir).sort(), ['ccc.png', 'ddd.png'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('pruneOldImages: 不足 keep 张不删;非 png 不碰', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mu-prune2-'))
  try {
    writeFileSync(join(dir, 'a.png'), 'x')
    writeFileSync(join(dir, 'keep.txt'), 'x')
    pruneOldImages(dir, 50)
    assert.deepEqual(readdirSync(dir).sort(), ['a.png', 'keep.txt'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('pruneOldImages: 目录不存在不抛', () => {
  assert.doesNotThrow(() => pruneOldImages('/tmp/mu-nonexistent-xyz-123', 10))
})

// ── execute 真实链路(mock fetch,不碰真 ComfyUI)──

// 按 url 路由的假 fetch:/prompt、/history、/view 三个端点各返回一个 Response
function mockFetch(h: { prompt?: () => Response; history?: () => Response; view?: () => Response }): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url)
    if (u.includes('/prompt')) return h.prompt ? h.prompt() : new Response('', { status: 500 })
    if (u.includes('/history')) return h.history ? h.history() : new Response('{}', { status: 200 })
    if (u.includes('/view')) return h.view ? h.view() : new Response(Buffer.from([1, 2, 3]), { status: 200 })
    throw new Error(`unexpected url ${u}`)
  }) as unknown as typeof fetch
}
function ctxWith(dataDir: string): ToolContext {
  return { config: {}, dataDir, log: () => {} } as unknown as ToolContext
}

test('image_gen execute: prompt 为空 → 失败,不碰网络', async () => {
  const r = await imageGenTool.execute({ prompt: '   ' }, ctxWith('/tmp'))
  assert.equal(r.success, false)
  assert.equal(r.error, '没说要画什么')
})

test('image_gen execute: ComfyUI 提交失败 → error', async () => {
  const orig = globalThis.fetch
  globalThis.fetch = mockFetch({ prompt: () => new Response('boom', { status: 500 }) })
  try {
    const r = await imageGenTool.execute({ prompt: 'a cat' }, ctxWith('/tmp'))
    assert.equal(r.success, false)
    assert.match(r.error ?? '', /提交失败/)
  } finally { globalThis.fetch = orig }
})

test('image_gen execute: 服务端 status error → 提前失败,不空转到 120s(reviewer #3)', async () => {
  const orig = globalThis.fetch
  globalThis.fetch = mockFetch({
    prompt: () => new Response(JSON.stringify({ prompt_id: 't1' }), { status: 200 }),
    history: () => new Response(JSON.stringify({ t1: { status: { status_str: 'error' }, outputs: {} } }), { status: 200 }),
  })
  const t0 = Date.now()
  try {
    const r = await imageGenTool.execute({ prompt: 'a cat' }, ctxWith('/tmp'))
    assert.equal(r.success, false)
    assert.match(r.error ?? '', /服务端报错/)
    assert.ok(Date.now() - t0 < 10000, '一次轮询就退出,没等满 120s')
  } finally { globalThis.fetch = orig }
})

test('image_gen execute: 成功路径 → 出图存盘,返回 生成图/ 相对路径', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mu-imggen-'))
  const orig = globalThis.fetch
  globalThis.fetch = mockFetch({
    prompt: () => new Response(JSON.stringify({ prompt_id: 't1' }), { status: 200 }),
    history: () => new Response(JSON.stringify({ t1: { outputs: { '9': { images: [{ filename: 'a.png', subfolder: '' }] } } } }), { status: 200 }),
    view: () => new Response(Buffer.from([137, 80, 78, 71]), { status: 200 }),
  })
  try {
    const r = await imageGenTool.execute({ prompt: 'a fluffy kitten' }, ctxWith(dir))
    assert.equal(r.success, true)
    assert.match(r.output, /生成图\/.*\.png/)
    assert.equal(readdirSync(join(dir, '生成图')).filter(f => f.endsWith('.png')).length, 1)
  } finally { globalThis.fetch = orig; rmSync(dir, { recursive: true, force: true }) }
})
