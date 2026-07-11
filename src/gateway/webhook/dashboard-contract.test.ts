import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

test('dashboard 消费真实 backtest report 的 strategy_name 和 data_range 契约', () => {
  const html = readFileSync(resolve(import.meta.dirname, '../../../web/index.html'), 'utf8')
  assert.match(html, /parameters\s*&&\s*b\.parameters\.strategy_name/)
  assert.match(html, /data_range\s*&&\s*b\.data_range\.start/)
  assert.match(html, /data_range\s*&&\s*b\.data_range\.end/)
  assert.match(html, /scheduler_calendar_health/)
  assert.match(html, /交易日历降级/)
})

test('dashboard 防御案例数组字段并隔离各渲染模块', () => {
  const html = readFileSync(resolve(import.meta.dirname, '../../../web/index.html'), 'utf8')
  assert.match(html, /Array\.isArray\(c\.catalysts\)/)
  assert.match(html, /Array\.isArray\(c\.risks\)/)
  assert.match(html, /safeRender\(renderStatus/)
  assert.match(html, /safeRender\(renderBacktest/)
  assert.match(html, /try\s*\{\s*render\(finance/s)
})
