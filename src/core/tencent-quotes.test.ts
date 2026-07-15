import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTencentPrices, parseTencentQuotePoints } from './tencent-quotes.js'

test('parseTencentPrices parses valid A-share quotes and rejects invalid values', () => {
  const result = parseTencentPrices('v_sz003816="51~中国广核~003816~3.65~~~~~~~~~~~~~~~~~~~~~~~~~~~20260713100001";v_sh600519="51~贵州茅台~600519~1200.50~~~~~~~~~~~~~~~~~~~~~~~~~~~20260713100002";v_sz000001="51~x~000001~0~~~~~~~~~~~~~~~~~~~~~~~~~~~20260713100003";')
  assert.deepEqual([...result], [['003816', 3.65], ['600519', 1200.5]])
})

test('parseTencentQuotePoints requires and converts exchange source timestamps', () => {
  const body = 'v_sz003816="51~中国广核~003816~3.65~~~~~~~~~~~~~~~~~~~~~~~~~~~20260713100001";'
  assert.deepEqual(parseTencentQuotePoints(body).get('003816'), { name: '中国广核', price: 3.65, asOf: '2026-07-13T02:00:01.000Z', sources: ['tencent'] })
  assert.equal(parseTencentQuotePoints('v_sz003816="51~x~003816~3.65";').size, 0)
})

test('parseTencentQuotePoints preserves auditable trailing valuation fields', () => {
  const fields = Array.from({ length: 53 }, () => '')
  fields[1] = '中微公司'; fields[2] = '688012'; fields[3] = '391.04'; fields[30] = '20260715144808'
  fields[39] = '68.50'; fields[44] = '2450.30'; fields[46] = '12.40'
  const quote = parseTencentQuotePoints(`v_sh688012="${fields.join('~')}";`).get('688012')
  assert.deepEqual(quote, {
    name: '中微公司', price: 391.04, asOf: '2026-07-15T06:48:08.000Z',
    peTtm: 68.5, pb: 12.4, marketCapYi: 2450.3, sources: ['tencent'],
  })
})
