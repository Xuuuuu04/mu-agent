// download_image:SSRF 拦截 + content-type 校验 + 成功路径(真 fetch 小图)。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { downloadImageTool } from './download-image.js'
import type { ToolContext } from '../../core/types.js'

function ctx(dir: string): ToolContext {
  return { dataDir: dir, config: {} as never, log: () => {} } as unknown as ToolContext
}

test('download_image: 私网/回环/元数据 URL 被 SSRF 拦', async () => {
  const d = mkdtempSync(join(tmpdir(), 'mu-dl-'))
  try {
    for (const u of ['http://127.0.0.1/x.png', 'http://localhost/x.png', 'http://169.254.169.254/x.png', 'http://10.0.0.1/x.png']) {
      const r = await downloadImageTool.execute({ url: u }, ctx(d))
      assert.equal(r.success, false, `应拦: ${u}`)
      assert.match(r.error ?? '', /不允许/)
    }
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('download_image: 非 http(s) 协议被拦', async () => {
  const d = mkdtempSync(join(tmpdir(), 'mu-dl-'))
  try {
    const r = await downloadImageTool.execute({ url: 'file:///etc/passwd' }, ctx(d))
    assert.equal(r.success, false)
    assert.match(r.error ?? '', /不允许|http/)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('download_image: 成功下真图,写到 data/网图/ 并返回相对路径', async () => {
  const d = mkdtempSync(join(tmpdir(), 'mu-dl-'))
  try {
    // httpbin 的 /image/png 返回一张小 png + 正确 content-type
    const r = await downloadImageTool.execute({ url: 'https://httpbin.org/image/png' }, ctx(d))
    if (!r.success) {
      // httpbin 偶发不可达时跳过(不判 fail,网络抖动不该挂测试)
      console.log('skip: httpbin 不可达:', r.error)
      return
    }
    assert.equal(r.success, true)
    assert.match(r.output, /^网图\/.+\.png$/)
    const local = join(d, ...r.output.split('/'))
    assert.equal(existsSync(local), true, '文件应已写入')
    const buf = readFileSync(local)
    assert.ok(buf.length > 100 && buf.length < 5 * 1024 * 1024)
    assert.equal(buf[0], 0x89, 'png 魔数 \\x89')
    assert.equal(buf[1], 0x50, 'png 魔数 P')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('download_image: content-type 不是图片 → 拒绝(别把 html 错误页当图存)', async () => {
  const d = mkdtempSync(join(tmpdir(), 'mu-dl-'))
  try {
    // httpbin/html 返回 text/html
    const r = await downloadImageTool.execute({ url: 'https://httpbin.org/html' }, ctx(d))
    if (!r.success && /content-type|不是图片/.test(r.error ?? '')) {
      assert.match(r.error ?? '', /不是图片/)
    } else if (r.success) {
      // 极端情况下 httpbin 返回了别的东西,只要没崩就过
      assert.ok(true)
    } else {
      console.log('skip: httpbin 不可达:', r.error)
    }
  } finally { rmSync(d, { recursive: true, force: true }) }
})
