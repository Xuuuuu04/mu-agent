import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProceduralLayer } from './procedural.js'

// 临时 dataDir,内含 skills/ 目录;每个用例独立目录,finally 清理
function withDataDir(
  files: Record<string, string>,
  fn: (dataDir: string) => void,
  opts: { noSkillsDir?: boolean } = {},
): void {
  const dataDir = mkdtempSync(join(tmpdir(), 'mu-proc-'))
  try {
    if (!opts.noSkillsDir) {
      const skillsDir = join(dataDir, 'skills')
      mkdirSync(skillsDir, { recursive: true })
      for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(skillsDir, name), content, 'utf-8')
      }
    }
    fn(dataDir)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
}

const fm = (name: string, trigger: string[], body: string, tools?: string[]) => {
  const lines = [`name: ${name}`, `trigger: [${trigger.map(t => JSON.stringify(t)).join(', ')}]`]
  if (tools) lines.push(`tools: [${tools.map(t => JSON.stringify(t)).join(', ')}]`)
  return `---\n${lines.join('\n')}\n---\n${body}`
}

test('assemble: 空输入返回空串', () => {
  withDataDir({ 'a.md': fm('哄人', ['emo'], '步骤一') }, (dir) => {
    const layer = new ProceduralLayer(dir)
    assert.equal(layer.assemble(), '')
    assert.equal(layer.assemble(''), '')
  })
})

test('assemble: trigger 关键词命中 → 注入技能 body', () => {
  withDataDir({ 'comfort.md': fm('哄哥哥', ['难过', 'emo'], '抱抱他\n说点暖的') }, (dir) => {
    const layer = new ProceduralLayer(dir)
    const out = layer.assemble('哥哥今天好难过')
    assert.match(out, /相关技能/)
    assert.match(out, /【哄哥哥】/)
    assert.match(out, /抱抱他/)
  })
})

test('assemble: 无命中 → 空串', () => {
  withDataDir({ 'comfort.md': fm('哄哥哥', ['难过'], '步骤') }, (dir) => {
    const layer = new ProceduralLayer(dir)
    assert.equal(layer.assemble('今天天气不错'), '')
  })
})

test('assemble: 命中是子串匹配(includes),不是分词', () => {
  // trigger "运维" 命中 "运维工作" 这种包含子串的输入
  withDataDir({ 'ops.md': fm('运维', ['运维'], 'pm2 重启') }, (dir) => {
    const layer = new ProceduralLayer(dir)
    assert.match(layer.assemble('帮我做点运维工作'), /pm2 重启/)
  })
})

test('assemble: 最多注入 2 个技能(slice(0,2))', () => {
  withDataDir({
    's1.md': fm('技能一', ['key'], 'body1'),
    's2.md': fm('技能二', ['key'], 'body2'),
    's3.md': fm('技能三', ['key'], 'body3'),
  }, (dir) => {
    const layer = new ProceduralLayer(dir)
    const out = layer.assemble('key')
    const names = ['技能一', '技能二', '技能三'].filter(n => out.includes(n))
    assert.equal(names.length, 2, '只注入前 2 个命中的')
  })
})

test('parse: 没 frontmatter 的文件不作技能(返回 null,不命中)', () => {
  withDataDir({ 'plain.md': '这是纯知识\n触发词 emo 也在正文里' }, (dir) => {
    const layer = new ProceduralLayer(dir)
    // 没 frontmatter → loadSkills 跳过 → assemble 空
    assert.equal(layer.assemble('emo'), '')
    assert.deepEqual(layer.list(), [])
  })
})

test('parse: trigger 缺失或空数组 → 该技能被丢弃', () => {
  withDataDir({
    'no-trigger.md': '---\nname: 无触发\n---\n正文',
    'empty-trigger.md': '---\nname: 空触发\ntrigger: []\n---\n正文',
  }, (dir) => {
    const layer = new ProceduralLayer(dir)
    assert.deepEqual(layer.list(), [], '两个都没合法 trigger → 全丢')
  })
})

test('parse: meta.name 缺失时用文件名兜底', () => {
  withDataDir({ 'fallback-name.md': '---\ntrigger: ["xx"]\n---\n正文' }, (dir) => {
    const layer = new ProceduralLayer(dir)
    assert.deepEqual(layer.list(), ['fallback-name'])
  })
})

test('parse: 坏 YAML frontmatter 不崩,被跳过', () => {
  withDataDir({
    'broken.md': '---\nname: [未闭合\ntrigger: ["x"\n---\n正文',
    'good.md': fm('好的', ['ok'], '正文'),
  }, (dir) => {
    const layer = new ProceduralLayer(dir)
    assert.doesNotThrow(() => layer.list())
    assert.deepEqual(layer.list(), ['好的'])
  })
})

test('loadSkills: 非 .md 文件被忽略', () => {
  withDataDir({
    'skill.md': fm('真技能', ['hit'], '正文'),
    'notes.txt': fm('假技能', ['hit'], '正文'),
  }, (dir) => {
    const layer = new ProceduralLayer(dir)
    assert.deepEqual(layer.list(), ['真技能'])
  })
})

test('loadSkills: skills 目录不存在 → 空,不崩', () => {
  withDataDir({}, (dir) => {
    const layer = new ProceduralLayer(dir)
    assert.deepEqual(layer.list(), [])
    assert.equal(layer.assemble('任何输入'), '')
  }, { noSkillsDir: true })
})

test('缓存: 30s 内不重扫盘,新增文件要 invalidate 才生效', () => {
  withDataDir({ 's1.md': fm('技能一', ['k'], 'b1') }, (dir) => {
    const layer = new ProceduralLayer(dir)
    assert.deepEqual(layer.list(), ['技能一'])
    // 直接往盘上加一个,缓存还在 → list 不变
    writeFileSync(join(dir, 'skills', 's2.md'), fm('技能二', ['k'], 'b2'), 'utf-8')
    assert.deepEqual(layer.list(), ['技能一'], '命中缓存,看不到新文件')
    // invalidate 后才看得到
    layer.invalidate()
    assert.deepEqual(layer.list().sort(), ['技能一', '技能二'])
  })
})
