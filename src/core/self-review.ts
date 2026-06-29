// 自我 review:Task 置 done / deliverable 交付前,跑一次独立 LLM pass 对照 DoD。
// 死亡螺旋红线(设计 §3.1 R6/R7):
//   - fail-open:router 异常/超时/cooldown/解析失败一律返 pass,绝不抛异常冒泡进 runCycle catch
//     (否则 review 失败被算进 3 连败自愈)。
//   - 不进 sessionHistory:review 走独立 router.chat,不产生孤儿 tool_result。
//   - review_rounds 上界 2:第 2 轮仍 fail 强制放行打 review_status:'failed',不无限重做。
import type { MuConfig, ProviderConfig, ReviewVerdict } from './types.js'
import { ModelRouter } from '../providers/router.js'

export interface ReviewResult {
  verdict: ReviewVerdict
  note: string
}

// review_rounds 硬上界:第 2 轮(rounds>=2)仍 fail 就强制放行。
export const MAX_REVIEW_ROUNDS = 2

const REVIEW_SYSTEM = `你是一个严格的验收审查者。对照给定的验收标准(DoD)审查一份产出,判断它够不够格交付。
只看 DoD 有没有被满足,不发挥、不挑 DoD 之外的毛病。
返回严格的 JSON,不要别的:{"verdict": "pass" 或 "fail", "note": "一句话说明哪条没满足 / 为什么过"}`.trim()

// 容错解析:模型可能裹 markdown 代码块、加前后缀、JSON 不规整。
// 抠出 verdict(只认 fail,其余按 pass)+ note。解析不出 verdict 时 fail-open 返 pass。
export function parseReviewResult(text: string): ReviewResult {
  const raw = (text ?? '').trim()
  if (!raw) return { verdict: 'pass', note: 'review 无输出,放行' }

  // 先试着抠出 JSON 对象(可能裹在 ```json ... ``` 或散文里)
  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]) as { verdict?: unknown; note?: unknown }
      const v = String(obj.verdict ?? '').toLowerCase()
      const note = typeof obj.note === 'string' ? obj.note : ''
      if (v === 'fail') return { verdict: 'fail', note: note || '未通过(模型未给理由)' }
      if (v === 'pass') return { verdict: 'pass', note: note || '通过' }
      // verdict 字段存在但不是 pass/fail → 落到下面的文本兜底
    } catch {
      // JSON 烂掉 → 落到下面的文本兜底
    }
  }

  // 文本兜底:JSON 没抠到/烂掉时,从散文里找明确的 fail 信号(只有明确 fail 才打回,
  // 其余 fail-open 当 pass —— 解析不确定时绝不卡死交付)。
  if (/"?verdict"?\s*[:：]?\s*"?fail"?/i.test(raw) || /\bfail\b|不通过|不合格|未通过/i.test(raw)) {
    return { verdict: 'fail', note: raw.slice(0, 200) }
  }
  return { verdict: 'pass', note: 'review 输出无法解析为明确结论,放行' }
}

// 独立 pass:用传入的 router(调用方用 forProvider 取 fallback/primary)审一遍。
// 任何异常 → fail-open 返 pass。绝不抛(R6)。
export async function runSelfReview(
  dod: string,
  output: string,
  router: ModelRouter,
  log: (msg: string) => void = () => {},
): Promise<ReviewResult> {
  const dodText = (dod ?? '').trim()
  // 没有 DoD 就无从审起 —— 放行(不是 review 系统该挡的)
  if (!dodText) return { verdict: 'pass', note: '无验收标准,跳过 review' }

  try {
    const response = await router.chat({
      system: REVIEW_SYSTEM,
      messages: [{
        role: 'user',
        content: `[验收标准 DoD]\n${dodText}\n\n[待审查的产出]\n${(output ?? '').trim() || '(产出为空)'}\n\n对照 DoD 审查这份产出,够不够格?返回 JSON {verdict, note}:`,
      }],
      max_tokens: 1000,
      // 验收是判断题,不值得长推理;1000 max_tokens 别被 reasoning 吃光
      thinking: 'disabled',
    })
    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
    return parseReviewResult(text)
  } catch (e) {
    // R6 铁律:router 挂/超时/全冷却 → fail-open 放行,绝不冒泡
    log(`[self-review] review 不可用,fail-open 放行: ${(e as Error).message}`)
    return { verdict: 'pass', note: 'review 不可用,放行' }
  }
}

// 取独立 review 模型:优先 fallback[0](独立性,如 claude-sonnet-4-6),
// 没配 fallback 则降级用 primary 同模型自审(方案 a)。
// 取不到任何 provider / config 残缺返 null(调用方据此 fail-open 直接放行)。绝不抛。
export function buildReviewRouter(config: MuConfig): ModelRouter | null {
  try {
    const pick: ProviderConfig | undefined = config?.model?.fallback?.[0] ?? config?.model?.primary
    if (!pick) return null
    return ModelRouter.forProvider(pick)
  } catch {
    return null
  }
}

export interface ReviewGateResult {
  passed: boolean       // 是否放行(置 done / 交付)
  forced: boolean       // 是否因撞 2 轮上界强制放行(打 review_status:'failed')
  note: string          // review 意见(打回时给模型看)
  rounds: number        // 更新后的 review_rounds
}

// reviewGate:Task done / commitment_done / deliverable 交付前的统一闸门。
// - 先算轮数:已经第 2 轮(prevRounds>=MAX-1)再来一次直接强制放行,连模型都不烧。
// - 否则跑 runSelfReview:pass→放行;fail→不放行,rounds++,把意见返给模型。
// - fail-open:buildReviewRouter 取不到 / runSelfReview 异常 → 放行(runSelfReview 内部已兜底)。
// 绝不抛异常(R6)。
// router 参数:生产传 undefined,由 config 自动取(forProvider→fallback/primary);测试可注入 mock。
export async function reviewGate(
  dod: string,
  output: string,
  prevRounds: number,
  config: MuConfig,
  log: (msg: string) => void = () => {},
  router?: ModelRouter | null,
): Promise<ReviewGateResult> {
  const rounds = Math.max(0, prevRounds | 0)

  // 已经审过 MAX-1 次还要再审 = 这是第 MAX 次,强制放行不无限重做(R7)
  if (rounds >= MAX_REVIEW_ROUNDS - 1) {
    return {
      passed: true,
      forced: true,
      note: `已达 ${MAX_REVIEW_ROUNDS} 轮自审上限,强制放行(标记 review_status:failed)`,
      rounds: rounds + 1,
    }
  }

  const r = router !== undefined ? router : buildReviewRouter(config)
  if (!r) {
    // 取不到任何 review 模型 → fail-open 放行
    return { passed: true, forced: false, note: 'review 模型不可用,放行', rounds }
  }

  const result = await runSelfReview(dod, output, r, log)
  if (result.verdict === 'pass') {
    return { passed: true, forced: false, note: result.note, rounds }
  }
  // fail:不放行,轮数 +1
  return { passed: false, forced: false, note: result.note, rounds: rounds + 1 }
}
