import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { AdminApi } from './admin-api.js'
import { Outbox } from './outbox.js'

test('/api/status exposes deploy revision and build time fields', async () => {
  let raw = ''
  const res = {
    writeHead() { return this },
    end(chunk?: string) { raw = chunk ?? ''; return this },
  } as unknown as ServerResponse
  const api = new AdminApi({
    store: null,
    opts: {},
    outbox: new Outbox(null),
    getEventHandler: () => null,
  })
  const handled = await api.tryHandle('/api/status', 'GET', {} as IncomingMessage, res, new URLSearchParams())
  const body = JSON.parse(raw) as Record<string, unknown>
  assert.equal(handled, true)
  assert.equal(typeof body.revision, 'string')
  assert.ok((body.revision as string).length > 0)
  assert.ok(Object.hasOwn(body, 'build_time'))
})
