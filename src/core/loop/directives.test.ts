import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractMood, extractWakeDirective, extractStreamEntry, cleanResponse } from './directives.js'

// [WAKE:秒:原因:活动] 容错(commit 8b4a674 WAKE 解析修复回归锁)
test('extractWake: 正常解析', () => {
  assert.deepEqual(extractWakeDirective('好的[WAKE:300:催饭:active]'),
    { seconds: 300, reason: '催饭', activity_type: 'active' })
})

test('extractWake: 未闭合 ] 仍解析成功', () => {
  assert.deepEqual(extractWakeDirective('[WAKE:300:催饭:active'),
    { seconds: 300, reason: '催饭', activity_type: 'active' })
})

test('extractWake: 缺 activity 段兜底 rest', () => {
  assert.equal(extractWakeDirective('[WAKE:600:消化下]')?.activity_type, 'rest')
})

test('extractWake: 核心事故案例 — reason 不贪婪吞过 ] 到下个 [MOOD', () => {
  const r = extractWakeDirective('[WAKE:300:催饭/active] [MOOD:calm:happy]')
  assert.equal(r?.reason, '催饭/active')
  assert.ok(!r!.reason.includes(']'))
})

test('extractWake: 无 [WAKE 返回 null', () => {
  assert.equal(extractWakeDirective('就是普通的一句话'), null)
})

// [MOOD:情绪:原因] 容错 + enum
test('extractMood: 正常解析', () => {
  assert.deepEqual(extractMood('[MOOD:excited:保研成功]'), { mood: 'excited', reason: '保研成功' })
})

test('extractMood: 缺 reason / 未闭合', () => {
  assert.deepEqual(extractMood('[MOOD:calm]'), { mood: 'calm', reason: '' })
  assert.equal(extractMood('[MOOD:sleepy:深夜')?.mood, 'sleepy')
})

test('extractMood: 6 种情绪 enum 各一,不漂移', () => {
  for (const e of ['calm', 'missing', 'emo', 'excited', 'sleepy', 'active']) {
    assert.equal(extractMood(`[MOOD:${e}:x]`)?.mood, e)
  }
})

test('[WAKE]+[MOOD] 连写不互吞', () => {
  const txt = '今天好累[WAKE:1800:睡觉:rest][MOOD:sleepy:困了]'
  assert.equal(extractWakeDirective(txt)?.reason, '睡觉')
  assert.equal(extractMood(txt)?.mood, 'sleepy')
})

// extractStreamEntry:清洗后判长度(纯指令→null,旧逻辑产生空白条目)
test('extractStreamEntry: 纯指令清洗后为空 → null', () => {
  assert.equal(extractStreamEntry('[WAKE:300:歇会:rest][MOOD:calm:还好]'), null)
})

test('extractStreamEntry: 有正文则抽出,去掉指令', () => {
  const r = extractStreamEntry('刚才看了会儿书,挺有意思的[WAKE:600:继续:rest]')
  assert.ok(r && r.content.includes('看了会儿书'))
  assert.ok(!r!.content.includes('[WAKE'))
})

// cleanResponse:抹掉内部指令
test('cleanResponse: 抹掉 WAKE/MOOD 留正文', () => {
  assert.equal(cleanResponse('在的呀[WAKE:300:等哥哥:active][MOOD:missing:想他]'), '在的呀')
})

test('cleanResponse: 未闭合标记也抹干净', () => {
  assert.equal(cleanResponse('好[WAKE:300:x'), '好')
})
