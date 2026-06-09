// 把记忆文本里的相对时间词固化成绝对日期。
// 核心问题:记忆里存"哥哥明天答辩",过几天再读到"明天"就错位了。
// 写入长期记忆(user-facts / commitments)前,把"明天/昨天/后天"换成"6月2日"这种绝对日期。
// 只在写入侧用,读取/对话侧不动(那里相对时间是对的)。

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function fmtDate(d: Date): string {
  return `${d.getMonth() + 1}月${d.getDate()}日(${WEEKDAYS[d.getDay()]})`
}

function dayOffset(now: Date, n: number): Date {
  const x = new Date(now)
  x.setHours(0, 0, 0, 0)
  x.setDate(x.getDate() + n)
  return x
}

export function absolutizeTime(text: string, now = new Date()): string {
  if (!text) return text

  // 顺序重要:长词先匹配(大后天 在 后天 之前,否则"大后天"会被"后天"先吃掉)
  const rules: Array<[RegExp, number]> = [
    [/大后天/g, 3],
    [/大前天/g, -3],
    [/后天/g, 2],
    [/前天/g, -2],
    [/明天|明日|明早|明晚/g, 1],
    [/昨天|昨日|昨晚|昨儿/g, -1],
    [/今天|今日|今晚|今早|今儿/g, 0],
  ]

  let out = text
  for (const [re, n] of rules) {
    out = out.replace(re, fmtDate(dayOffset(now, n)))
  }

  // 周/月这种范围词不好固化成单日,给它加个绝对锚点而不是替换
  const monday = dayOffset(now, ((1 - now.getDay()) + 7) % 7 || 0)
  out = out
    .replace(/下周|下星期|下礼拜/g, m => `${m}(${fmtDate(dayOffset(monday, 7))}那周)`)
    .replace(/上周|上星期|上礼拜/g, m => `${m}(${fmtDate(dayOffset(monday, -7))}那周)`)

  return out
}
