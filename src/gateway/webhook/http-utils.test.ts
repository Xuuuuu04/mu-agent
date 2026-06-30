import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { isOriginAllowed, readBody } from './http-utils.js'

function requestBody(parts: string[]): IncomingMessage {
  return Readable.from(parts) as unknown as IncomingMessage
}

test('readBody:默认最多 1MB,超限立即拒绝', async () => {
  const req = requestBody(['x'.repeat(700_000), 'y'.repeat(400_000)])
  await assert.rejects(readBody(req), /body too large/i)
})

test('readBody:限制内完整返回', async () => {
  assert.equal(await readBody(requestBody(['abc', '中文'])), 'abc中文')
})

test('Origin:无 Origin 的 bridge/curl 放行,同源浏览器放行', () => {
  assert.equal(isOriginAllowed(undefined, '127.0.0.1:3210'), true)
  assert.equal(isOriginAllowed('http://127.0.0.1:3210', '127.0.0.1:3210'), true)
  assert.equal(isOriginAllowed('http://localhost:3210', 'localhost:3210'), true)
})

test('Origin:任意外站和畸形 Origin 拒绝', () => {
  assert.equal(isOriginAllowed('https://evil.example', '127.0.0.1:3210'), false)
  assert.equal(isOriginAllowed('not-a-url', '127.0.0.1:3210'), false)
})
