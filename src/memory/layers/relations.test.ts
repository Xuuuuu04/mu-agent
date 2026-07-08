import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RelationsLayer } from './relations.js'
import type { Commitment } from '../../core/types.js'

// dataDir/memory/ 下放 user-facts.md / commitments.json
function withDataDir(
  setup: { facts?: string; commitments?: unknown } ,
  fn: (dataDir: string) => void,
): void {
  const dataDir = mkdtempSync(join(tmpdir(), 'mu-rel-'))
  try {
    const memDir = join(dataDir, 'memory')
    mkdirSync(memDir, { recursive: true })
    if (setup.facts !== undefined) {
      writeFileSync(join(memDir, 'user-facts.md'), setup.facts, 'utf-8')
    }
    if (setup.commitments !== undefined) {
      const raw = typeof setup.commitments === 'string'
        ? setup.commitments
        : JSON.stringify(setup.commitments)
      writeFileSync(join(memDir, 'commitments.json'), raw, 'utf-8')
    }
    fn(dataDir)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
}

const mkCommit = (over: Partial<Commitment>): Commitment => ({
  id: 'c1',
  content: '陪哥哥',
  type: 'one-time',
  status: 'active',
  created: '2026-06-01T00:00:00.000Z',
  ...over,
})

test('assemble: 两个源都没有 → 兜底提示串', () => {
  withDataDir({}, (dir) => {
    const layer = new RelationsLayer(dir)
    assert.equal(layer.assemble(), '(还没有记住关于用户的事实)')
  })
})

test('assemble: 只有 facts → 带标题注入', () => {
  withDataDir({ facts: '哥哥喜欢喝咖啡\n生日 5-27' }, (dir) => {
    const layer = new RelationsLayer(dir)
    const out = layer.assemble()
    assert.match(out, /关于用户\(你记住的事实\)/)
    assert.match(out, /喜欢喝咖啡/)
    assert.match(out, /生日 5-27/)
  })
})

test('loadFacts: 空白/全空格文件视为无事实', () => {
  withDataDir({ facts: '   \n  \n' }, (dir) => {
    const layer = new RelationsLayer(dir)
    // trim 后为空 → loadFacts 返回 null → 没承诺 → 兜底
    assert.equal(layer.assemble(), '(还没有记住关于用户的事实)')
  })
})

test('loadFacts: 超 3000 字截断 + 省略尾注', () => {
  const big = '甲'.repeat(3500)
  withDataDir({ facts: big }, (dir) => {
    const layer = new RelationsLayer(dir)
    const out = layer.assemble()
    assert.match(out, /\(更多事实省略\)/)
    // 正文部分甲数量 = 3000(截断点),不是 3500
    const jia = (out.match(/甲/g) || []).length
    assert.equal(jia, 3000)
  })
})

test('commitments: 只装配 status===active 的', () => {
  withDataDir({
    commitments: [
      mkCommit({ id: 'a', content: '活跃承诺', status: 'active' }),
      mkCommit({ id: 'b', content: '完成承诺', status: 'done' }),
      // 老数据可能残留已废弃的 cancelled 状态;runtime 只装配 active,这类一律过滤掉
      mkCommit({ id: 'c', content: '取消承诺', status: 'cancelled' as Commitment['status'] }),
    ],
  }, (dir) => {
    const layer = new RelationsLayer(dir)
    const out = layer.assemble()
    assert.match(out, /你答应过的事/)
    assert.match(out, /活跃承诺/)
    assert.doesNotMatch(out, /完成承诺/)
    assert.doesNotMatch(out, /取消承诺/)
    assert.match(out, /\[a\]/)
  })
})

test('commitments: schedule / last_done 字段拼进行', () => {
  const oneHourAgo = new Date(Date.now() - 3600_000 - 60_000).toISOString()
  withDataDir({
    commitments: [
      mkCommit({ id: 'r', content: '每天问候', schedule: '每天 9 点', last_done: oneHourAgo }),
    ],
  }, (dir) => {
    const layer = new RelationsLayer(dir)
    const out = layer.assemble()
    assert.match(out, /\[每天 9 点\]/)
    assert.match(out, /上次:/)
    assert.match(out, /小时前/)
  })
})

test('formatDue: 已过期显示天数 + 感叹', () => {
  const past = new Date(Date.now() - 3 * 86400_000).toISOString()
  withDataDir({
    commitments: [mkCommit({ id: 'd', content: '交东西', due: past })],
  }, (dir) => {
    const layer = new RelationsLayer(dir)
    assert.match(layer.assemble(), /已过期\d+天!/)
  })
})

test('formatDue: 8 天以上原样返回 ISO 串(>7 天分支)', () => {
  const future = new Date(Date.now() + 20 * 86400_000).toISOString()
  withDataDir({
    commitments: [mkCommit({ id: 'f', content: '远期', due: future })],
  }, (dir) => {
    const layer = new RelationsLayer(dir)
    const out = layer.assemble()
    // >7 天直接返回原 due 字符串(不是相对天数)
    assert.ok(out.includes(future), '20 天后应原样返回 ISO')
  })
})

test('commitments: 坏 JSON → 当无承诺,不崩', () => {
  withDataDir({ facts: '哥哥爱看书', commitments: '{坏的 json' }, (dir) => {
    const layer = new RelationsLayer(dir)
    const out = layer.assemble()
    assert.match(out, /爱看书/)
    assert.doesNotMatch(out, /你答应过的事/)
  })
})

test('facts + commitments 同时存在,顺序:事实在前承诺在后', () => {
  withDataDir({
    facts: '哥哥的事',
    commitments: [mkCommit({ id: 'x', content: '我的承诺' })],
  }, (dir) => {
    const layer = new RelationsLayer(dir)
    const out = layer.assemble()
    assert.ok(out.indexOf('哥哥的事') < out.indexOf('我的承诺'))
  })
})

// ── 持仓注入(A 股垂直化)──
function withPortfolio(positions: unknown, fn: (dataDir: string) => void): void {
  const dataDir = mkdtempSync(join(tmpdir(), 'mu-rel-port-'))
  try {
    const memDir = join(dataDir, 'memory')
    mkdirSync(memDir, { recursive: true })
    writeFileSync(join(memDir, 'portfolio.json'), JSON.stringify(positions), 'utf-8')
    fn(dataDir)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
}

test('portfolio: 只装配 active 持仓,带 code/name/qty/cost/止损止盈', () => {
  withPortfolio([
    { id: 'p1', code: '003816', name: '中国广核', qty: 100, cost: 3.87, stop_loss: 3.70, take_profit: 4.10, status: 'active', updated: '2026-07-08T00:00:00.000Z' },
    { id: 'p2', code: '688012', name: '中微公司', qty: 50, cost: 400, status: 'active', updated: '2026-07-08T00:00:00.000Z' },
    { id: 'p3', code: '601398', name: '工商银行', qty: 200, cost: 5.0, status: 'closed', updated: '2026-07-01T00:00:00.000Z' },
  ], (dir) => {
    const out = new RelationsLayer(dir).assemble()
    assert.match(out, /当前持仓\(真实账户,非模拟盘\)/)
    assert.match(out, /003816 中国广核 100股@3.87 止损3.7 止盈4.1/)
    assert.match(out, /688012 中微公司 50股@400\b/)  // 无止损止盈,行尾
    assert.doesNotMatch(out, /工商银行/)             // closed 不注入
    assert.match(out, /watchdog 盘中会按止损/)
  })
})

test('portfolio: 坏 JSON → 当无持仓,不崩', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mu-rel-portbad-'))
  try {
    const memDir = join(dataDir, 'memory')
    mkdirSync(memDir, { recursive: true })
    writeFileSync(join(memDir, 'portfolio.json'), '{坏的', 'utf-8')
    const out = new RelationsLayer(dataDir).assemble()
    assert.doesNotMatch(out, /当前持仓/)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})
