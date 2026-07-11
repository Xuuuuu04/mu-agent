import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTencentPrices, parseTencentQuotePoints } from './tencent-quotes.js'

test('parseTencentPrices parses valid A-share quotes and rejects invalid values', () => {
  const result = parseTencentPrices('v_sz003816="51~中国广核~003816~3.65~~~~~~~~~~~~~~~~~~~~~~~~~~~20260713100001";v_sh600519="51~贵州茅台~600519~1200.50~~~~~~~~~~~~~~~~~~~~~~~~~~~20260713100002";v_sz000001="51~x~000001~0~~~~~~~~~~~~~~~~~~~~~~~~~~~20260713100003";')
  assert.deepEqual([...result], [['003816', 3.65], ['600519', 1200.5]])
})

test('parseTencentQuotePoints requires and converts exchange source timestamps', () => {
  const body = 'v_sz003816="51~中国广核~003816~3.65~~~~~~~~~~~~~~~~~~~~~~~~~~~20260713100001";'
  assert.deepEqual(parseTencentQuotePoints(body).get('003816'), { price: 3.65, asOf: '2026-07-13T02:00:01.000Z' })
  assert.equal(parseTencentQuotePoints('v_sz003816="51~x~003816~3.65";').size, 0)
})
