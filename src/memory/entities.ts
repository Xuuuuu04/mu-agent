// 轻量实体抽取。没接 NER,用规则 + 已知实体词典凑合。
// 抽到的实体存进 episodes.entities 列,情景检索时按实体回捞相关记忆。

const TITLE_RE = /《([^》]{1,20})》/g          // 书名/作品名
const QUOTE_RE = /「([^」]{1,20})」/g          // 引用
const ENG_RE = /\b([A-Z][a-zA-Z]{1,19})\b/g    // 英文专有名词(首字母大写)

// 抽取实体。dictionary 是已知实体集(从历史记忆里攒的),命中就算一个实体。
export function extractEntities(text: string, dictionary?: Set<string>): string[] {
  const found = new Set<string>()

  for (const re of [TITLE_RE, QUOTE_RE, ENG_RE]) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const term = m[1]!.trim()
      if (term.length >= 2) found.add(term)
    }
  }

  if (dictionary) {
    for (const entity of dictionary) {
      if (entity.length >= 2 && text.includes(entity)) found.add(entity)
    }
  }

  return [...found].slice(0, 8)
}
