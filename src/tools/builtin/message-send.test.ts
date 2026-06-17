import { test } from 'node:test'
import assert from 'node:assert/strict'
import { messageSendTool } from './message-send.js'
import type { ToolContext, MuConfig } from '../../core/types.js'

// message_send 的 dedup map 是模块级状态,跨用例不重置。
// 每个用例用唯一文本(带随机后缀)避免互相污染 60s 去重。
let seq = 0
function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${seq++}`
}

// 构造一个最小 ToxtContext。proactive 的 quiet 窗口可调,默认设成"绝不命中当前小时"。
function makeCtx(opts: {
  quiet?: { start: number; end: number }
  sendMessage?: (text: string, imagePath?: string) => Promise<void>
  store?: ToolContext['store']
} = {}): ToolContext & { calls: Array<{ text: string; imagePath?: string }>; logs: string[] } {
  const calls: Array<{ text: string; imagePath?: string }> = []
  const logs: string[] = []
  // 默认 quiet 窗口设成永不命中:start=end=当前小时,qs<qe 为 false 时 → hour>=qs||hour<qe。
  // 为稳妥起见,默认用 start=current, end=current → qs===qe,qs<qe 为 false,
  // inQuiet = hour>=qs || hour<qe = true(命中!)。所以默认要显式设一个不命中的窗口。
  const proactive = opts.quiet
    ? { enabled: true, max_per_hour: 1, quiet_start_hour: opts.quiet.start, quiet_end_hour: opts.quiet.end }
    : undefined
  const config = {
    proactive,
  } as unknown as MuConfig
  const sendMessage = opts.sendMessage
    ?? (async (text: string, imagePath?: string) => { calls.push({ text, imagePath }) })
  return {
    config,
    dataDir: '/tmp/none',
    log: (m: string) => logs.push(m),
    store: opts.store,
    sendMessage,
    calls,
    logs,
  }
}

// 计算一个"当前小时一定不在 quiet 内"的窗口。
// qs<qe 分支:inQuiet = hour>=qs && hour<qe。取 qs=qe=(h+1)%24 → qs<qe false → 走另一分支。
// 干脆构造一个明确不含 h 的窗口:start=(h+1)%24, end=(h+2)%24,且保证 start<end 时不含 h。
function nonQuietWindow(): { start: number; end: number } {
  const h = new Date().getHours()
  // 选一个长度为1的窗口 [h+2, h+3),它不含 h。处理跨午夜:若 h+2 或 h+3 溢出,绕回。
  let start = (h + 2) % 24
  let end = (h + 3) % 24
  // 保证 start<end(同分支)且不含 h。若 start>end(跨午夜)inQuiet=hour>=start||hour<end。
  // 跨午夜窗口很窄(只 1 小时),h 不在其中,仍判 false。两种都安全。
  return { start, end }
}

// 计算一个"当前小时一定在 quiet 内"的窗口:[h, h+1) 含 h。
function quietWindow(): { start: number; end: number } {
  const h = new Date().getHours()
  const start = h
  const end = (h + 1) % 24
  return { start, end }
}

test('message_send: 文本和图都为空 → 失败 "消息为空"', async () => {
  const ctx = makeCtx({ quiet: nonQuietWindow() })
  const r = await messageSendTool.execute({ text: '   ' }, ctx)
  assert.equal(r.success, false)
  assert.equal(r.error, '消息为空')
  assert.equal(ctx.calls.length, 0)
})

test('message_send: 正常发送 → 调 sendMessage 并返回 "发出去了"', async () => {
  const ctx = makeCtx({ quiet: nonQuietWindow() })
  const text = uniq('正常发送')
  const r = await messageSendTool.execute({ text }, ctx)
  assert.equal(r.success, true)
  assert.equal(r.output, '发出去了')
  assert.equal(ctx.calls.length, 1)
  assert.equal(ctx.calls[0]!.text, text)
  assert.equal(ctx.calls[0]!.imagePath, undefined)
})

test('message_send: 60s 内同内容第二次发被去重拦下', async () => {
  const ctx = makeCtx({ quiet: nonQuietWindow() })
  const text = uniq('去重内容')
  const r1 = await messageSendTool.execute({ text }, ctx)
  assert.equal(r1.success, true)
  const r2 = await messageSendTool.execute({ text }, ctx)
  assert.equal(r2.success, false)
  assert.equal(r2.error, '这条刚发过(60秒内去重)')
  // 第二次没有再调 sendMessage
  assert.equal(ctx.calls.length, 1)
})

test('message_send: 去重 key = text + imagePath,带不同图视为不同消息', async () => {
  const ctx = makeCtx({ quiet: nonQuietWindow() })
  const text = uniq('同文不同图')
  const r1 = await messageSendTool.execute({ text, image_path: '/tmp/a.png' }, ctx)
  const r2 = await messageSendTool.execute({ text, image_path: '/tmp/b.png' }, ctx)
  assert.equal(r1.success, true)
  assert.equal(r2.success, true)
  assert.equal(ctx.calls.length, 2)
  // 第三次完全相同(同文同图)才被去重
  const r3 = await messageSendTool.execute({ text, image_path: '/tmp/b.png' }, ctx)
  assert.equal(r3.success, false)
})

test('message_send: quiet 时段非紧急被软拦,不调 sendMessage', async () => {
  const ctx = makeCtx({ quiet: quietWindow() })
  const text = uniq('深夜早安')
  const r = await messageSendTool.execute({ text }, ctx)
  assert.equal(r.success, false)
  assert.match(r.error ?? '', /哥哥多半在睡|急事/)
  assert.equal(ctx.calls.length, 0)
})

test('message_send: quiet 时段带 urgent:true 放行', async () => {
  const ctx = makeCtx({ quiet: quietWindow() })
  const text = uniq('急事')
  const r = await messageSendTool.execute({ text, urgent: true }, ctx)
  assert.equal(r.success, true)
  assert.equal(ctx.calls.length, 1)
})

test('message_send: quiet 拦截优先于去重(空内容除外) —— 拦截发生在 sendMessage 之前', async () => {
  // 注:空内容判定在 quiet 之前,所以这里用非空文本验证拦截顺序。
  const ctx = makeCtx({ quiet: quietWindow() })
  const text = uniq('被拦的话')
  const r = await messageSendTool.execute({ text }, ctx)
  assert.equal(r.success, false)
  // 因为被拦,没有写入 dedup,放行后(urgent)还能正常发
  const r2 = await messageSendTool.execute({ text, urgent: true }, ctx)
  assert.equal(r2.success, true)
})

test('message_send: 没有 sendMessage 通道 → 失败', async () => {
  const ctx = makeCtx({ quiet: nonQuietWindow() })
  // 显式去掉 sendMessage
  ;(ctx as { sendMessage?: unknown }).sendMessage = undefined
  const text = uniq('无通道')
  const r = await messageSendTool.execute({ text }, ctx)
  assert.equal(r.success, false)
  assert.equal(r.error, '当前没有可用的发送通道')
})

test('message_send: sendMessage 抛错 → 返回 error,不记 dedup', async () => {
  const ctx = makeCtx({
    quiet: nonQuietWindow(),
    sendMessage: async () => { throw new Error('网关挂了') },
  })
  const text = uniq('抛错')
  const r = await messageSendTool.execute({ text }, ctx)
  assert.equal(r.success, false)
  assert.equal(r.error, '网关挂了')
})

test('message_send: 成功后把主动消息写进 episodes(store.insertEpisode)', async () => {
  const inserted: Array<{ content: string; role: string; source: string }> = []
  const fakeStore = {
    insertEpisode(ep: { content: string; role: string; source: string }) {
      inserted.push({ content: ep.content, role: ep.role, source: ep.source })
    },
  } as unknown as ToolContext['store']
  const ctx = makeCtx({ quiet: nonQuietWindow(), store: fakeStore })
  const text = uniq('记进记忆')
  const r = await messageSendTool.execute({ text }, ctx)
  assert.equal(r.success, true)
  assert.equal(inserted.length, 1)
  assert.equal(inserted[0]!.role, 'assistant')
  assert.equal(inserted[0]!.source, 'chat')
  assert.match(inserted[0]!.content, /^\(主动发给哥哥\) /)
  assert.match(inserted[0]!.content, new RegExp(text))
})

test('message_send: image_path 透传给 sendMessage', async () => {
  const ctx = makeCtx({ quiet: nonQuietWindow() })
  const text = uniq('带图')
  const r = await messageSendTool.execute({ text, image_path: '/tmp/cat.png' }, ctx)
  assert.equal(r.success, true)
  assert.equal(ctx.calls[0]!.imagePath, '/tmp/cat.png')
})

test('message_send: 只有图没有文字也能发(text 空但 image 非空)', async () => {
  const ctx = makeCtx({ quiet: nonQuietWindow() })
  const r = await messageSendTool.execute({ image_path: `/tmp/${uniq('onlyimg')}.png` }, ctx)
  assert.equal(r.success, true)
  assert.equal(ctx.calls.length, 1)
  assert.equal(ctx.calls[0]!.text, '')
})

// ── image_path 路径规范化(06-17:修表情包相对路径直传 bridge 必 404 的根因)──

test('message_send: 相对图片路径规范化为 dataDir 下绝对路径(表情包/生成图都靠这个)', async () => {
  const ctx = makeCtx({ quiet: nonQuietWindow() })
  await messageSendTool.execute({ text: uniq('相对图'), image_path: '表情包/开心蹦跳.png' }, ctx)
  assert.equal(ctx.calls[0]!.imagePath, '/tmp/none/表情包/开心蹦跳.png')
})

test('message_send: 带 data/ 前缀也剥掉,不双重嵌套(dataDir/data/x 坑)', async () => {
  const ctx = makeCtx({ quiet: nonQuietWindow() })
  await messageSendTool.execute({ text: uniq('data前缀'), image_path: 'data/生成图/abc.png' }, ctx)
  assert.equal(ctx.calls[0]!.imagePath, '/tmp/none/生成图/abc.png')
})

test('message_send: 绝对图片路径原样透传(image_gen 也可返回绝对)', async () => {
  const ctx = makeCtx({ quiet: nonQuietWindow() })
  await messageSendTool.execute({ text: uniq('绝对图'), image_path: '/tmp/none/x/cat.png' }, ctx)
  assert.equal(ctx.calls[0]!.imagePath, '/tmp/none/x/cat.png')
})

test('message_send: 图片路径逃出 data 沙箱 → 失败,不发', async () => {
  const ctx = makeCtx({ quiet: nonQuietWindow() })
  const r = await messageSendTool.execute({ text: uniq('逃逸'), image_path: '../../etc/passwd' }, ctx)
  assert.equal(r.success, false)
  assert.match(r.error ?? '', /data 外面/)
  assert.equal(ctx.calls.length, 0)
})
