import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPathInside } from './static-server.js'

// 目录逃逸防护:安全敏感
const WEB = '/srv/mu/web'

test('正常路径落在 webDir 内', () => {
  assert.ok(isPathInside(WEB, '/index.html'))
  assert.ok(isPathInside(WEB, '/style.css'))
  assert.ok(isPathInside(WEB, '/'))           // → /index.html
})

test('../ 逃逸被挡', () => {
  assert.ok(!isPathInside(WEB, '/../etc/passwd'))
  assert.ok(!isPathInside(WEB, '/../../secret'))
})

test('同前缀兄弟目录(web-evil)被挡', () => {
  // join('/srv/mu/web', '/../web-evil/x') => '/srv/mu/web-evil/x'，
  // startsWith('/srv/mu/web') 会误判,必须靠 + sep 边界拦住
  assert.ok(!isPathInside(WEB, '/../web-evil/x'))
})
