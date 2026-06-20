import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { relativeTime, TemporalLayer } from './temporal.js'

// 固定一个 now,所有 relativeTime 用例都以它为基准,避免依赖系统时钟
const NOW = new Date('2026-06-15T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms)
const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
const DAY = 24 * HOUR

// ---------- relativeTime:相对时间格式化 ----------

test('relativeTime: past 在未来(diffMs<0)返回刚刚', () => {
  assert.equal(relativeTime(new Date(NOW.getTime() + 5000), NOW), '刚刚')
})

test('relativeTime: 不足 60 秒返回刚刚', () => {
  assert.equal(relativeTime(ago(0), NOW), '刚刚')
  assert.equal(relativeTime(ago(59 * SEC), NOW), '刚刚')
})

test('relativeTime: 恰好 60 秒进入分钟档 = 1分钟前', () => {
  assert.equal(relativeTime(ago(60 * SEC), NOW), '1分钟前')
})

test('relativeTime: 分钟档 1~59', () => {
  assert.equal(relativeTime(ago(5 * MIN), NOW), '5分钟前')
  assert.equal(relativeTime(ago(59 * MIN), NOW), '59分钟前')
})

test('relativeTime: 整小时不带分钟', () => {
  assert.equal(relativeTime(ago(2 * HOUR), NOW), '2小时前')
})

test('relativeTime: 带余数分钟的小时档', () => {
  assert.equal(relativeTime(ago(2 * HOUR + 30 * MIN), NOW), '2小时30分钟前')
  assert.equal(relativeTime(ago(1 * HOUR + 1 * MIN), NOW), '1小时1分钟前')
})

test('relativeTime: 23小时59分钟仍是小时档', () => {
  assert.equal(relativeTime(ago(23 * HOUR + 59 * MIN), NOW), '23小时59分钟前')
})

test('relativeTime: 恰好 24 小时 = 昨天(days===1)', () => {
  assert.equal(relativeTime(ago(24 * HOUR), NOW), '昨天')
})

test('relativeTime: 1天多一点仍算昨天(days 向下取整=1)', () => {
  assert.equal(relativeTime(ago(36 * HOUR), NOW), '昨天')
})

test('relativeTime: 2~6 天用 N天前', () => {
  assert.equal(relativeTime(ago(2 * DAY), NOW), '2天前')
  assert.equal(relativeTime(ago(6 * DAY), NOW), '6天前')
})

test('relativeTime: 7~29 天用 N周前(整除向下)', () => {
  assert.equal(relativeTime(ago(7 * DAY), NOW), '1周前')
  assert.equal(relativeTime(ago(13 * DAY), NOW), '1周前') // floor(13/7)=1
  assert.equal(relativeTime(ago(14 * DAY), NOW), '2周前')
  assert.equal(relativeTime(ago(29 * DAY), NOW), '4周前') // floor(29/7)=4
})

test('relativeTime: >=30 天用 N个月前(按30天/月)', () => {
  assert.equal(relativeTime(ago(30 * DAY), NOW), '1个月前')
  assert.equal(relativeTime(ago(59 * DAY), NOW), '1个月前') // floor(59/30)=1
  assert.equal(relativeTime(ago(60 * DAY), NOW), '2个月前')
  assert.equal(relativeTime(ago(365 * DAY), NOW), '12个月前') // 没有"年"档
})

// ---------- TemporalLayer.assemble:整体装配(间接覆盖 formatDateTime/getPeriod) ----------

function withDataDir(fn: (dataDir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'mu-temporal-'))
  try {
    mkdirSync(join(dir, 'memory'), { recursive: true })
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('assemble: 不传任何参数也至少有"现在"和"系统状态"两行', () => {
  withDataDir((dir) => {
    const out = new TemporalLayer(dir).assemble()
    assert.match(out, /^现在: \d{4}-\d{2}-\d{2} \d{2}:\d{2} 周[日一二三四五六] .+/m)
    assert.match(out, /系统状态: /)
  })
})

test('assemble: 传 lastUserContact 注入"距上次和用户说话"', () => {
  withDataDir((dir) => {
    const out = new TemporalLayer(dir).assemble(new Date(Date.now() - 5 * MIN))
    assert.match(out, /距上次和用户说话: 5分钟前/)
  })
})

test('assemble: 传 lastWake 注入"距上次唤醒"带活动', () => {
  withDataDir((dir) => {
    const out = new TemporalLayer(dir).assemble(undefined, {
      time: new Date(Date.now() - 2 * HOUR),
      activity: '写日记',
    })
    assert.match(out, /距上次唤醒: 2小时前 \(写日记\)/)
  })
})

test('assemble: 过期 active commitment 标记"今天!"', () => {
  withDataDir((dir) => {
    const yesterday = new Date(Date.now() - DAY).toISOString()
    writeFileSync(
      join(dir, 'memory', 'commitments.json'),
      JSON.stringify([
        { content: '陪哥哥吃饭', status: 'active', type: 'once', due: yesterday },
      ]),
    )
    const out = new TemporalLayer(dir).assemble()
    assert.match(out, /待办提醒:/)
    assert.match(out, /陪哥哥吃饭 \(今天!\)/)
  })
})

test('assemble: recurring commitment 无 due 也保留,直接显示内容', () => {
  withDataDir((dir) => {
    writeFileSync(
      join(dir, 'memory', 'commitments.json'),
      JSON.stringify([{ content: '每天问候', status: 'active', type: 'recurring' }]),
    )
    const out = new TemporalLayer(dir).assemble()
    assert.match(out, /- 每天问候/)
  })
})

test('assemble: 非 active 的 commitment 被过滤掉', () => {
  withDataDir((dir) => {
    writeFileSync(
      join(dir, 'memory', 'commitments.json'),
      JSON.stringify([
        { content: '已完成的事', status: 'done', type: 'once', due: new Date().toISOString() },
      ]),
    )
    const out = new TemporalLayer(dir).assemble()
    assert.doesNotMatch(out, /已完成的事/)
    // 没有有效待办时连"待办提醒:"标题都不出现
    assert.doesNotMatch(out, /待办提醒:/)
  })
})

test('assemble: 远期 once commitment(超过明天)被过滤', () => {
  withDataDir((dir) => {
    const farFuture = new Date(Date.now() + 10 * DAY).toISOString()
    writeFileSync(
      join(dir, 'memory', 'commitments.json'),
      JSON.stringify([
        { content: '十天后的事', status: 'active', type: 'once', due: farFuture },
      ]),
    )
    const out = new TemporalLayer(dir).assemble()
    assert.doesNotMatch(out, /十天后的事/)
  })
})

test('assemble: commitments 最多 5 条', () => {
  withDataDir((dir) => {
    const items = Array.from({ length: 8 }, (_, i) => ({
      content: `事项${i}`,
      status: 'active',
      type: 'recurring',
    }))
    writeFileSync(join(dir, 'memory', 'commitments.json'), JSON.stringify(items))
    const out = new TemporalLayer(dir).assemble()
    const lines = out.split('\n').filter((l) => l.trim().startsWith('- 事项'))
    assert.equal(lines.length, 5)
  })
})
