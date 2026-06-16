import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorldLayer } from './world.js'

function withDataDir(
  files: Record<string, string>,
  fn: (dataDir: string) => void,
  opts: { noKnowledgeDir?: boolean } = {},
): void {
  const dataDir = mkdtempSync(join(tmpdir(), 'mu-world-'))
  try {
    if (!opts.noKnowledgeDir) {
      const kdir = join(dataDir, 'knowledge')
      mkdirSync(kdir, { recursive: true })
      for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(kdir, name), content, 'utf-8')
      }
    }
    fn(dataDir)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
}

test('assemble: 空输入返回空串', () => {
  withDataDir({ 'a.md': '咖啡 拿铁 牛奶 咖啡因' }, (dir) => {
    const layer = new WorldLayer(dir)
    assert.equal(layer.assemble(), '')
    assert.equal(layer.assemble(''), '')
  })
})

test('assemble: 关键词重合 >=2 → 注入笔记', () => {
  // tokenize 按"空白分隔的整段"切词,中文不分词 → term 必须用空格隔开才能精确相等匹配。
  // 笔记 terms 含 "咖啡"/"拿铁";输入用空格分出同样两词 → overlap 2 命中。
  withDataDir({ 'coffee.md': '咖啡 拿铁 加奶的浓缩' }, (dir) => {
    const layer = new WorldLayer(dir)
    const out = layer.assemble('咖啡 拿铁')
    assert.match(out, /相关笔记/)
    assert.match(out, /【coffee】/)
    assert.match(out, /拿铁/)
  })
})

test('坑: 中文不分词,连写的"想喝咖啡"≠笔记里的"咖啡",整段为一个 term', () => {
  // characterization:tokenize 不做中文分词,"想喝咖啡" 是一个完整 term,
  // 不等于笔记里的 "咖啡" term → overlap=0 → 不命中(子串匹配在这层是失效的)。
  withDataDir({ 'coffee.md': '咖啡 拿铁 牛奶' }, (dir) => {
    const layer = new WorldLayer(dir)
    assert.equal(layer.assemble('想喝咖啡 来杯拿铁'), '', '连写中文词匹配不上单独的 term')
  })
})

test('assemble: 重合度 <2 → 不注入(阈值 score>=2)', () => {
  // 只有 "咖啡" 一个词重合 → score 1 < 2 → 不命中
  withDataDir({ 'coffee.md': '咖啡 是一种饮料' }, (dir) => {
    const layer = new WorldLayer(dir)
    assert.equal(layer.assemble('咖啡 好喝'), '', '只重合 1 个词不够')
  })
})

test('tokenize: 长度 <2 的词被丢弃(单字/单字母不计入)', () => {
  // 输入 "a b 我 你" 全是长度 1 → queryTerms 为空 → 直接空串
  withDataDir({ 'n.md': '随便 内容 这里 有词' }, (dir) => {
    const layer = new WorldLayer(dir)
    assert.equal(layer.assemble('a b 我 你'), '', '全是单字符,tokenize 后为空')
  })
})

test('tokenize: 标点/符号被当分隔符', () => {
  // "机器学习,深度学习!" → 标点切开成两个 >=2 的词
  withDataDir({ 'ml.md': '机器学习 和 深度学习 都是 AI' }, (dir) => {
    const layer = new WorldLayer(dir)
    const out = layer.assemble('机器学习,深度学习!')
    assert.match(out, /【ml】/)
  })
})

test('assemble: 多篇命中按 score 降序,最多 2 篇', () => {
  withDataDir({
    'high.md': 'alpha beta gamma delta',     // 与输入重合 alpha beta gamma → 3
    'mid.md': 'alpha beta omega',            // 重合 alpha beta → 2
    'low.md': 'alpha solo',                  // 重合 alpha → 1,被过滤
  }, (dir) => {
    const layer = new WorldLayer(dir)
    const out = layer.assemble('alpha beta gamma')
    // 只有 high(3) 和 mid(2) 入选,low(1) 被阈值挡掉
    const highIdx = out.indexOf('【high】')
    const midIdx = out.indexOf('【mid】')
    assert.ok(highIdx >= 0 && midIdx >= 0, 'high 和 mid 都注入')
    assert.equal(out.indexOf('【low】'), -1, 'low 被过滤')
    assert.ok(highIdx < midIdx, 'high 排在 mid 前(score 降序)')
  })
})

test('assemble: content 截断到 400 字', () => {
  const longBody = 'alpha beta ' + '甲'.repeat(800)
  withDataDir({ 'big.md': longBody }, (dir) => {
    const layer = new WorldLayer(dir)
    const out = layer.assemble('alpha beta')
    // 注入段最长 = 头部 + 【big】 + 400 字切片,正文部分不会出现第 401 个甲
    // 用整段甲数量近似:截断后甲数远少于 800
    const jiaCount = (out.match(/甲/g) || []).length
    assert.ok(jiaCount <= 400, `截断后甲应 <=400,实际 ${jiaCount}`)
    assert.ok(jiaCount > 0, '有内容注入')
  })
})

test('loadNotes: 非 .md 忽略 + 坏读不崩', () => {
  withDataDir({
    'good.md': 'alpha beta gamma',
    'junk.txt': 'alpha beta gamma',
  }, (dir) => {
    const layer = new WorldLayer(dir)
    assert.deepEqual(layer.list(), ['good'])
  })
})

test('loadNotes: knowledge 目录不存在 → 空,不崩', () => {
  withDataDir({}, (dir) => {
    const layer = new WorldLayer(dir)
    assert.deepEqual(layer.list(), [])
    assert.equal(layer.assemble('alpha beta'), '')
  }, { noKnowledgeDir: true })
})

test('缓存: 30s 内不重扫,invalidate 后看到新文件', () => {
  withDataDir({ 'n1.md': 'alpha beta' }, (dir) => {
    const layer = new WorldLayer(dir)
    assert.deepEqual(layer.list(), ['n1'])
    writeFileSync(join(dir, 'knowledge', 'n2.md'), 'gamma delta', 'utf-8')
    assert.deepEqual(layer.list(), ['n1'], '命中缓存')
    layer.invalidate()
    assert.deepEqual(layer.list().sort(), ['n1', 'n2'])
  })
})
