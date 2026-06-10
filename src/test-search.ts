// 搜索后端手动对照:tsx src/test-search.ts [搜索词]
// 默认测 bing;设了 MINIMAX_KEY 环境变量则测 minimax(生产 key 在 xpark config)
// 验收标准:返回非 null、≥3 条结果、每条有标题、无残留 HTML 标签
import { bingSearch, minimaxSearch } from './tools/builtin/search.js'

const query = process.argv[2] ?? '哥德尔不完备定理'
const mmKey = process.env.MINIMAX_KEY
const r = mmKey ? await minimaxSearch(query, mmKey) : await bingSearch(query)
if (mmKey) console.log('[后端: minimax]')

if (!r) {
  console.error(`FAIL: bingSearch("${query}") 返回 null`)
  process.exit(1)
}

const entries = r.split('\n\n')
const hasTags = /<[a-z]+[^>]*>/i.test(r)
console.log(r)
console.log('---')
console.log(`条数: ${entries.length}  含HTML标签: ${hasTags}`)

if (entries.length >= 3 && !hasTags) {
  console.log('PASS')
} else {
  console.error('FAIL: 条数不足 3 或有未剥净的标签')
  process.exit(1)
}
