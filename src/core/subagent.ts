// 子代理 runner:把一段自包含任务交给隔离的子代理(受限工具子集)跑完拿结论。
// 死亡螺旋红线(设计 §7,逐条守):
//   - 子代理用函数内【局部 messages 数组】,assistant/tool_result 成对 push 进这个局部数组(累积),
//     绝不进主 session(trimHistory 看不到,跑完即 GC)。回调写局部数组而非 noop——否则带 tool_use 的
//     assistant 块不进历史,第二轮只剩孤儿 tool_result → GLM 400(worker 用工具必跑不通)。
//   - fail-open 总闸:超时/异常一律收成 SubagentResult{success:false},绝不 throw 出函数
//     (否则冒泡进 runCycle 的 try,被算进 3 连败自愈)。
//   - subCtx 由调用方(spawn 工具)裁掉 sendMessage/scheduleWake;worker 工具子集再剔黑名单。
//   - 子代理不调 postProcess/insertEpisode/markActivity;onStreamEntry noop,store 只读检索。
import type { ChatMessage, MuConfig, ProviderConfig, ReviewVerdict, ToolContext } from './types.js'
import type { ToolRegistry } from '../tools/registry.js'
import { ModelRouter } from '../providers/router.js'
import { runToolLoop, type ToolLoopResult } from './loop/tool-loop.js'
import { cleanResponse } from './loop/directives.js'
import { runSelfReview } from './self-review.js'

// ── 上界常量(防自主循环失控/递归爆栈/token 雪崩,模型改不动。仿 active-tasks.ts:10-12)──
export const MAX_SUBAGENT_CONCURRENT = 2     // 内存+配额主闸:同时在飞的子代理数
export const MAX_SUBAGENTS_PER_TASK = 4      // token 主闸:单父 cycle 累计 spawn 数
export const MAX_SUBAGENT_DEPTH = 1          // 递归红线:depth>=1 不准再 spawn
export const SUBAGENT_MAX_TURNS = 6          // 单子代理工具循环硬上限(再大也 clamp 到 8)
export const SUBAGENT_MAX_TURNS_HARD = 8
export const SUBAGENT_TIMEOUT_MS = 120_000   // 单子代理挂死拖垮父 cycle 预算的兜底
export const SUBAGENT_MAX_TOKENS = 2048      // 单轮 output 上限(子代理非深谈,不需 8192)
export const SUBAGENT_INPUT_BUDGET = 80_000  // 单父 cycle 子代理 input token 累加上限(撞顶拒后续 spawn,防成本失控)

// ── 父 cycle 级共享计数器(模块级,单进程串行 cycle 互斥,无并发抢)──
// spawn_subagent(工具)和 runSubagentsParallel(并行 runner)共用同一组闸:并发位 + 总数 + input 预算。
// 故意放 runner 模块(D1)而非工具模块(D2):并行 runner 也要这组闸,放这里两边都能 import。
// resetSubagentTaskBudget() 由 agent-loop 每个 runCycle 开头调一次,把"父 cycle 累计"清零。
let activeSubagents = 0          // 并发位:在飞的子代理数,acquire/release 成对,finally 必减
let spawnedThisTask = 0          // 单父 cycle 累计 spawn 数(总数主闸)
let inputTokensThisTask = 0      // 单父 cycle 子代理累计 input token(预算闸)

export function resetSubagentTaskBudget(): void {
  spawnedThisTask = 0
  inputTokensThisTask = 0
}

// 并发位获取:满则返 false(调用方据此拒/排队);成功自增,调用方 finally 必调 releaseConcurrency。
export function tryAcquireConcurrency(): boolean {
  if (activeSubagents >= MAX_SUBAGENT_CONCURRENT) return false
  activeSubagents++
  return true
}
export function releaseConcurrency(): void {
  if (activeSubagents > 0) activeSubagents--
}
export function getActiveSubagents(): number {
  return activeSubagents
}

// 总数闸:撞 MAX_SUBAGENTS_PER_TASK 返 false;否则占一个名额(自增)并返 true。
export function tryReserveSpawnSlot(): boolean {
  if (spawnedThisTask >= MAX_SUBAGENTS_PER_TASK) return false
  spawnedThisTask++
  return true
}
export function spawnSlotExhausted(): boolean {
  return spawnedThisTask >= MAX_SUBAGENTS_PER_TASK
}
// input 预算闸:已累计撞 SUBAGENT_INPUT_BUDGET 返 false(拒后续 spawn)。
export function inputBudgetExhausted(): boolean {
  return inputTokensThisTask >= SUBAGENT_INPUT_BUDGET
}
export function recordInputTokens(n: number): void {
  if (n > 0) inputTokensThisTask += n
}

export type SubagentRole = 'worker' | 'reviewer'

export interface SubagentSpec {
  role: SubagentRole
  prompt: string                    // 自包含任务描述(子代理看不到主对话历史)
  dod?: string                      // reviewer:验收标准;worker 可选(传了则跑完自审,本期 runner 暂不串审)
  allowTools?: string[]             // worker 工具白名单(默认见 spawn-subagent.ts);reviewer 忽略
  maxTurns?: number                 // 默认 SUBAGENT_MAX_TURNS,clamp 到 [1, SUBAGENT_MAX_TURNS_HARD]
}

export interface SubagentResult {
  role: SubagentRole
  success: boolean                  // worker: stopReason==='done' 且有实质文本;reviewer: 总 true(fail-open)
  output: string                    // worker=最终文本结论;reviewer=verdict+note
  verdict?: ReviewVerdict           // reviewer 专属
  turns: number
  toolCallCount: number
  stopReason?: 'done' | 'max_turns' | 'budget' | 'cancelled' | 'timeout' | 'error'
  note?: string                     // 失败/降级原因(给主代理看)
  inputTokens?: number              // 本子代理累计 input token(并行 runner 据此累加 SUBAGENT_INPUT_BUDGET)
}

// 超时哨兵:Promise.race 用,到点 resolve 一个标记值(不 reject,避免和正常路径混淆)。
// 返回句柄:race settle 后必须 clear(),否则悬空 setTimeout 把进程/测试拖到 ms 才退(MED 修复)。
const TIMEOUT = Symbol('subagent-timeout')

function timeout(ms: number): { promise: Promise<typeof TIMEOUT>; clear: () => void } {
  let handle: ReturnType<typeof setTimeout>
  const promise = new Promise<typeof TIMEOUT>(resolve => {
    handle = setTimeout(() => resolve(TIMEOUT), ms)
  })
  return { promise, clear: () => clearTimeout(handle) }
}

// 取独立子代理模型:优先 fallback[0](独立性,如 claude-sonnet-4-6),没配则降级用 primary。
// 取不到任何 provider / config 残缺返 null(调用方据此 fail-open:无可用模型则不 spawn)。绝不抛。
// 仿 self-review.ts:buildReviewRouter。
export function buildSubagentRouter(config: MuConfig): ModelRouter | null {
  try {
    const pick: ProviderConfig | undefined = config?.model?.fallback?.[0] ?? config?.model?.primary
    if (!pick) return null
    return ModelRouter.forProvider(pick)
  } catch {
    return null
  }
}

// 单个子代理。reviewer 复用 runSelfReview(一次性判断题);worker 走 runToolLoop(本地 messages 累积)。
// 整体 try/catch + 超时 race,任何异常/超时收成 SubagentResult{success:false},绝不 throw 出函数(R6 同款)。
export async function runSubagent(
  spec: SubagentSpec,
  subCtx: ToolContext,              // 已裁剪的子上下文(spawn 工具构造:去 sendMessage/scheduleWake,depth+1)
  router: ModelRouter,              // 非空,由调用方 buildSubagentRouter 取得
  fullRegistry: ToolRegistry,       // 主 registry,用于 subsetFor 取白名单工具定义
): Promise<SubagentResult> {
  try {
    if (spec.role === 'reviewer') {
      // reviewer:把 dod 当验收标准、prompt 当待审产出,跑一次独立 review。fail-open 内部已兜底(总返 pass/fail)。
      const r = await runSelfReview(spec.dod ?? '', spec.prompt, router, subCtx.log)
      // 成本观测:reviewer 是一次性判断题(runSelfReview 内部不暴露 input token,记 0)。
      console.log(`[subagent-cost] role=reviewer turns=1 toolCalls=0 inputTokens=0`)
      return {
        role: 'reviewer',
        success: true,              // reviewer 总成功(fail-open):它给的是 verdict,不是"跑没跑通"
        output: `[${r.verdict}] ${r.note}`,
        verdict: r.verdict,
        turns: 1,
        toolCallCount: 0,
        stopReason: 'done',
        note: r.note,
      }
    }

    // worker:受限工具子集 + 本地 messages 数组(起点只有任务 prompt,看不到主对话历史)。
    const tools = fullRegistry.subsetFor(spec.allowTools ?? [])
    // 物理子集隔离:executeTool 只放行子集里的工具名。subsetFor 已剔黑名单,这里把"模型看不到"
    // 升级成"调了也跑不了"——worker 幻觉出 message_send/schedule_wake 等名字直接拒(纵深防御)。
    const allowedNames = new Set(tools.map(t => t.name))
    const maxTurns = Math.min(
      SUBAGENT_MAX_TURNS_HARD,
      Math.max(1, Math.floor(spec.maxTurns ?? SUBAGENT_MAX_TURNS)),
    )
    // 本地 messages 数组:worker 的 assistant(tool_use) 和 tool_result 成对累积进这里(看不到主对话)。
    // 绝不进主 session(trimHistory 看不到,跑完即 GC)。回调 push 同一个数组 → 第二轮不再是孤儿块。
    const localMessages: ChatMessage[] = [{ role: 'user', content: spec.prompt }]
    // 超时取消标志:race 到点置 true,runToolLoop 下一轮开头读它带现有结果收尾(真停,不再跑满 maxTurns)。
    let cancelled = false
    const abortController = new AbortController()
    const sentinel = timeout(SUBAGENT_TIMEOUT_MS)

    let raced: ToolLoopResult | typeof TIMEOUT
    try {
      raced = await Promise.race([
        runToolLoop({
          system: WORKER_SYSTEM,
          messages: localMessages,
          tools,
          router,
          maxTurns,
          budgetMs: SUBAGENT_TIMEOUT_MS,
          maxTokens: SUBAGENT_MAX_TOKENS,
          abortSignal: abortController.signal,
          // 工具执行:先校验工具名在子集内(物理隔离),再走子代理受限 registry。内部 try/catch 不抛。
          executeTool: (name, input) =>
            allowedNames.has(name)
              ? fullRegistry.execute(name, input, subCtx)
              : Promise.resolve({ success: false, output: '', error: `子代理无权调用 ${name}` }),
          canExecuteInParallel: names => fullRegistry.areParallelSafe(names),
          // 本地累积 assistant/tool_result(不是 noop,否则第二轮只剩孤儿 tool_result → GLM 400)。
          // 中间产物仍不落主 session、不进主意识流——push 进的是函数内局部数组,跑完即 GC。
          onAssistant: (msg) => localMessages.push(msg),
          onToolResult: (msg) => localMessages.push(msg),
          onStreamEntry: () => {},      // 这个保持 noop:中间产物不落主意识流
          rebuildMessages: () => localMessages,  // 每轮用累积后的本地数组(子代理无 session/trimHistory)
          shouldCancel: () => cancelled,  // 超时哨兵置 cancelled,下一轮停
        }),
        sentinel.promise,
      ])
    } finally {
      // race settle 后立刻 clear 哨兵——否则悬空 setTimeout 把进程/测试拖到 120s 才退。
      sentinel.clear()
    }

    if (raced === TIMEOUT) {
      // 哨兵先到:置 cancelled 让后台那轮 runToolLoop 下一轮停(最坏多跑完当前这一轮 chat)。
      cancelled = true
      abortController.abort(new Error('subagent timeout'))
      return {
        role: 'worker',
        success: false,
        output: '',
        turns: 0,
        toolCallCount: 0,
        stopReason: 'timeout',
        note: `子代理超时(>${Math.round(SUBAGENT_TIMEOUT_MS / 1000)}s)`,
      }
    }

    const loop = raced
    const text = cleanResponse(loop.finalText) || loop.lastSubstantive
    // success 判定:正常停(done)且有实质文本。撞 max_turns/budget 或无文本算未完成。
    const success = loop.stopReason === 'done' && !!cleanResponse(text)
    // 成本观测:进 pm2 日志,监测她拆了多少子代理、单个烧多少(只数字,不打 prompt 正文)。
    console.log(`[subagent-cost] role=worker turns=${loop.turns} toolCalls=${loop.toolCallCount} inputTokens=${loop.usage.input}`)
    return {
      role: 'worker',
      success,
      output: text,
      turns: loop.turns,
      toolCallCount: loop.toolCallCount,
      stopReason: loop.stopReason,
      note: success ? undefined : `未跑出实质结论(stopReason=${loop.stopReason})`,
      inputTokens: loop.usage.input,
    }
  } catch (e) {
    // R6 铁律:任何异常 → fail-open 成结果,绝不冒泡进 runCycle 的 try(3 连败自愈)
    const msg = (e as Error).message
    subCtx.log(`[subagent] 异常,fail-open: ${msg}`)
    return {
      role: spec.role,
      success: false,
      output: '',
      turns: 0,
      toolCallCount: 0,
      stopReason: 'error',
      note: `子代理异常: ${msg}`,
    }
  }
}

// 一组 worker spec 并行跑(互不依赖的 fan-out)。设计 §2.2:
//   - Promise.allSettled 跑一批,任一失败/超时不拖垮其余(每个 runSubagent 内部已 fail-open,allSettled 是双保险)。
//   - 按 MAX_SUBAGENT_CONCURRENT 分批(别一次起一堆,1.6GB 小机)——每批拿并发位,跑完释放再起下一批。
//   - 复用父 cycle 共享闸:总数闸(tryReserveSpawnSlot,撞 MAX_SUBAGENTS_PER_TASK 拒后续)、
//     input 预算闸(inputBudgetExhausted,撞 SUBAGENT_INPUT_BUDGET 拒后续并累加 recordInputTokens)。
//   - 拒掉的(并发/总数/预算)收成 SubagentResult{success:false,stopReason:'budget'},不抛、不静默丢。
// 整体绝不 throw 出函数:allSettled 把异常收进结果(理论上 runSubagent 不抛,这里仍兜底)。
export async function runSubagentsParallel(
  specs: SubagentSpec[],
  parentCtx: ToolContext,
  router: ModelRouter,
  fullRegistry: ToolRegistry,
): Promise<SubagentResult[]> {
  const rejected = (note: string): SubagentResult => ({
    role: 'worker', success: false, output: '', turns: 0, toolCallCount: 0, stopReason: 'budget', note,
  })

  const results: SubagentResult[] = []
  // 按并发上限切批:每批最多 MAX_SUBAGENT_CONCURRENT 个同时在飞。
  for (let i = 0; i < specs.length; i += MAX_SUBAGENT_CONCURRENT) {
    const batch = specs.slice(i, i + MAX_SUBAGENT_CONCURRENT)
    const settled = await Promise.allSettled(
      batch.map(async (spec): Promise<SubagentResult> => {
        // 预算闸:撞顶直接拒(不烧模型、不占任何槽)。input 预算是成本主闸,最先查。
        if (inputBudgetExhausted()) {
          return rejected(`父 cycle 子代理 input 预算已用尽(>${SUBAGENT_INPUT_BUDGET}),这个子任务请你自己接手`)
        }
        // 并发位 acquire 先于总数 reserve:并发位有 release 兜底(finally 必减),
        // 而总数槽 spawnedThisTask 只增不减,所以放最后——只在并发位拿到、确定要跑时才占,
        // acquire 失败时直接拒(此时还没占总数槽,无泄漏)。批已按上限切,正常拿得到;
        // 拿不到(未来被并行的 spawn_subagent 占了)也拒不阻塞。
        if (!tryAcquireConcurrency()) {
          return rejected(`并发位已满(${MAX_SUBAGENT_CONCURRENT}),这个子任务请你自己接手`)
        }
        if (!tryReserveSpawnSlot()) {
          releaseConcurrency()  // 总数撞顶:回退刚拿到的并发位再拒(不进 try 的 finally)
          return rejected(`本轮已派出 ${MAX_SUBAGENTS_PER_TASK} 个子代理(上限),这个子任务请你自己接手`)
        }
        try {
          const r = await runSubagent(spec, parentCtx, router, fullRegistry)
          recordInputTokens(r.inputTokens ?? 0)  // 实际消耗累加进父 cycle 预算
          return r
        } finally {
          releaseConcurrency()  // 必减,防并发位泄漏(异常路径同样走到)
        }
      }),
    )
    // allSettled 不会 reject;rejected 分支理论碰不到(runSubagent 不抛),仍兜底收成失败结果。
    for (const s of settled) {
      results.push(
        s.status === 'fulfilled'
          ? s.value
          : { role: 'worker', success: false, output: '', turns: 0, toolCallCount: 0, stopReason: 'error', note: `并行子代理异常: ${String((s as PromiseRejectedResult).reason)}` },
      )
    }
  }
  return results
}

const WORKER_SYSTEM = `你是一个被派来完成单一具体任务的子代理。你看不到主对话的历史,任务全部写在用户消息里。
专注把这件事干完,用受限的工具(检索/读写文件等)。干完后用一段清晰的文字给出结论或产出,
不要寒暄、不要发消息给任何人、不要设闹钟(你也没有这些工具)。`.trim()
