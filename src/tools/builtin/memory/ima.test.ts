import { test } from 'node:test'
import assert from 'node:assert/strict'
import { imaConfigured, buildNoteSave, formatNoteHits, formatKbHits } from './ima.js'
import type { ImaConfig } from './ima.js'

const full: ImaConfig = { client_id: 'c', api_key: 'k' }

test('imaConfigured: 缺 client_id/api_key → false', () => {
  assert.equal(imaConfigured(undefined), false)
  assert.equal(imaConfigured({ client_id: '', api_key: 'k' } as ImaConfig), false)
  assert.equal(imaConfigured({ client_id: 'c', api_key: '' } as ImaConfig), false)
  assert.equal(imaConfigured(full), true)
})

test('buildNoteSave: 无 note_id → import_doc,正文带 # 标题', () => {
  const { apiPath, body } = buildNoteSave('八字基础', '天干地支')
  assert.equal(apiPath, 'openapi/note/v1/import_doc')
  assert.equal(body.content_format, 1)
  assert.equal(body.content, '# 八字基础\n\n天干地支')
  assert.equal('note_id' in body, false)
})

test('buildNoteSave: 有 note_id → append_doc,不带标题', () => {
  const { apiPath, body } = buildNoteSave('忽略的标题', '补充内容', '7474')
  assert.equal(apiPath, 'openapi/note/v1/append_doc')
  assert.equal(body.note_id, '7474')
  assert.equal(body.content, '\n\n补充内容')
})

test('buildNoteSave: 空标题 → 正文不带 # 前缀', () => {
  const { body } = buildNoteSave('', '裸内容')
  assert.equal(body.content, '裸内容')
})

test('formatNoteHits: 取 title/summary/note_id,截断', () => {
  const data = {
    search_note_infos: [
      { note_book_info: { title: '测试笔记', summary: '这是\n摘要', note_id: '999' } },
    ],
  }
  const hits = formatNoteHits(data)
  assert.equal(hits.length, 1)
  assert.match(hits[0]!, /《测试笔记》/)
  assert.match(hits[0]!, /这是 摘要/)   // \s+ 折叠
  assert.match(hits[0]!, /\[note:999\]/)
})

test('formatNoteHits: 空响应 → 空数组', () => {
  assert.deepEqual(formatNoteHits({}), [])
  assert.deepEqual(formatNoteHits({ search_note_infos: [] }), [])
})

test('formatKbHits: 跳过文件夹(media_type=99)、去 <em> 标签', () => {
  const data = {
    info_list: [
      { title: '文件夹A', media_type: 99 },
      { title: 'CPU缓存.pdf', media_type: 1, highlight_content: '关于 <em>CPU</em> 缓存' },
    ],
  }
  const hits = formatKbHits(data, '计算机体系结构')
  assert.equal(hits.length, 1, '文件夹被跳过')
  assert.match(hits[0]!, /\[计算机体系结构\] CPU缓存\.pdf/)
  assert.match(hits[0]!, /关于 CPU 缓存/)
  assert.ok(!hits[0]!.includes('<em>'))
})

test('formatKbHits: max 限制', () => {
  const data = { info_list: [
    { title: 'a', media_type: 1 }, { title: 'b', media_type: 1 }, { title: 'c', media_type: 1 },
  ] }
  assert.equal(formatKbHits(data, 'kb', 2).length, 2)
})
