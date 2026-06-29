// spawn_subagent 工具(reserved):主代理把自包含子任务交给隔离子代理跑。
// 三层 try/catch 中的【工具层】(runner 内部是另一层,registry.execute 最外层兜底)。
// 物理闸(都返 ToolResult,绝不抛 → 主 cycle 的 3 连败自愈永远碰不到):
//   ① depth 硬闸:depth>=MAX_SUBAGENT_DEPTH 直接拒,不烧模型(对标 active-tasks.ts:145)。
//   ② 并发 fail-closed:模块级 activeSubagents,先检后自增,finally 必减(防泄漏)。
//   ③ 总数闸:单父 cycle 累计 spawn 数撞 MAX_SUBAGENTS_PER_TASK 拒(计数器随 cycle 重置)。
// fail-open 延伸:worker 跑挂了工具仍返 success:true + "请你自己接手"(给主代理结构化反馈,主 cycle 照常成功);
// 只有 depth/并发/总数/无模型这类逻辑性拒绝才返 success:false。
import type { ToolDef, ToolContext, MuConfig } from '../../core/types.js'
import type { ToolRegistry } from '../registry.js'
import {
  runSubagent, runSubagentsParallel, buildSubagentRouter,
  MAX_SUBAGENT_DEPTH, MAX_SUBAGENT_CONCURRENT, MAX_SUBAGENTS_PER_TASK,
  tryAcquireConcurrency, releaseConcurrency, getActiveSubagents,
  tryReserveSpawnSlot, spawnSlotExhausted, recordInputTokens,
  resetSubagentTaskBudget,
  type SubagentSpec, type SubagentRole,
} from '../../core/subagent.js'

// worker 默认工具白名单(§4.1 微调):只读检索 + 干活。默认不含 image_gen(占 GPU/内存,要用走 allowTools 显式开)。
// 黑名单(spawn_*/message_send/voice_send/schedule_wake)由 registry.subsetFor 永久剔除,这里给不给都不影响。
const WORKER_DEFAULT_ALLOW = ['web_search', 'web_fetch', 'file_read', 'file_write', 'file_list', 'memory_search', 'weather']

// registry 后绑定:工具要 registry 引用做 subsetFor,但不塞进 ToolContext(保持 ctx 干净)。mu.ts 注册后调 bindRegistry。
let boundRegistry: ToolRegistry | null = null
export function bindRegistry(registry: ToolRegistry): void {
  boundRegistry = registry
}

// 并发位 / 总数 / input 预算计数器统一住在 subagent.ts(D1),spawn_subagent 与 spawn_parallel 共用同一组闸。
// 取舍:ToolContext 无 cycle id,塞进去会污染 ctx;故用模块级计数 + 显式重置——
// agent-loop 每个 runCycle 开头调 resetSubagentTaskBudget()(随 cycle 重置)。
// 单进程串行 cycle(AgentLoop.running 互斥),无并发 cycle 抢这个计数。
// 这里 re-export 让 agent-loop / 测试沿用原导入路径。
export { resetSubagentTaskBudget }

export const spawnSubagentTool: ToolDef = {
  name: 'spawn_subagent',
  description: '把一个自包含的子任务交给隔离的子代理去做。role=worker 干活(只有受限工具:检索/读写文件,发不了消息也设不了闹钟),role=reviewer 对照验收标准审一份产出。子代理看不到你的对话历史,prompt 必须自包含。子代理只是你的手脚,最终对用户说话的永远是你。',
  parameters: {
    role: {
      type: 'string',
      enum: ['worker', 'reviewer'],
      description: 'worker=干活;reviewer=审查(把待审产出放 prompt、验收标准放 dod)',
    },
    prompt: {
      type: 'string',
      description: '完整任务描述。子代理看不到你的对话历史,必须自包含:把背景、要做什么、期望产出讲清楚。reviewer 时这里放待审产出。',
    },
    dod: {
      type: 'string',
      description: 'reviewer:验收标准(对照它判 pass/fail)。worker 可选。',
      required: false as unknown as string,
    },
    allowTools: {
      type: 'array',
      items: { type: 'string' },
      description: 'worker 工具白名单(默认 web/file/memory_search)。spawn_*/message_send/voice_send/schedule_wake 永远剔除,给了也没用。',
      required: false as unknown as string,
    },
  },
  requiredKeys: ['role', 'prompt'],

  async execute(params, ctx) {
    // ① depth 硬闸:子代理(depth>=1)不准再 spawn 子代理,不烧模型直接拒
    if ((ctx.depth ?? 0) >= MAX_SUBAGENT_DEPTH) {
      return { success: false, output: '', error: '子代理不能再 spawn 子代理(已达最大递归深度)' }
    }

    const role = String(params.role ?? '') as SubagentRole
    if (role !== 'worker' && role !== 'reviewer') {
      return { success: false, output: '', error: "role 只能是 'worker' 或 'reviewer'" }
    }
    const prompt = String(params.prompt ?? '').trim()
    if (!prompt) {
      return { success: false, output: '', error: 'prompt 不能为空(子代理看不到你的历史,任务必须自包含)' }
    }

    if (!boundRegistry) {
      // 没绑 registry(理论不该发生,mu.ts 注册后即 bind)——降级,让主代理自己干
      return { success: false, output: '', error: '工具未就绪(registry 未绑定),请你自己处理这件事' }
    }

    // ③ 总数闸:单父 cycle 累计 spawn 太多,拒(token 主闸)。读-only 预检,正式占名额在增计数处。
    if (spawnSlotExhausted()) {
      return { success: false, output: '', error: `本轮已派出 ${MAX_SUBAGENTS_PER_TASK} 个子代理(上限),请自己把剩下的干完` }
    }

    // ② 并发 fail-closed:先检后自增,finally 必减。读-only 预检,正式占位在增计数处。
    if (getActiveSubagents() >= MAX_SUBAGENT_CONCURRENT) {
      return { success: false, output: '', error: `已有 ${MAX_SUBAGENT_CONCURRENT} 个子代理在跑(并发上限),稍后或自己处理` }
    }

    // 取独立子代理模型(fallback[0] 或 primary 降级);取不到则不 spawn,让主代理自己干
    const router = buildSubagentRouter(ctx.config as MuConfig)
    if (!router) {
      return { success: false, output: '', error: '无可用模型,请你自己干这件事' }
    }

    // 裁 subCtx(§4.2):故意省略 sendMessage / scheduleWake(双保险:白名单已剔依赖它们的工具),depth+1。
    const subCtx: ToolContext = {
      config: ctx.config,
      dataDir: ctx.dataDir,
      log: (m: string) => ctx.log(`[subagent:${role}] ${m}`),
      store: ctx.store,            // 只读检索可给(memory_search 用);worker 白名单不含写库工具
      depth: (ctx.depth ?? 0) + 1,
    }

    const spec: SubagentSpec = {
      role,
      prompt,
      dod: typeof params.dod === 'string' ? params.dod : undefined,
      allowTools: Array.isArray(params.allowTools)
        ? (params.allowTools as unknown[]).map(String)
        : role === 'worker' ? WORKER_DEFAULT_ALLOW : undefined,
    }

    // 正式占名额:并发位 + 总数(先检后增)。读-only 预检和这里之间无 await,串行 cycle 内无竞争。
    // acquire 先于 reserve:并发位有 release 兜底(finally 必减),总数槽只增不减放最后,
    // 与 runSubagentsParallel 同序——未来并发模型下 acquire 失败也不会先吃掉总数名额。
    tryAcquireConcurrency()     // 占并发位(已过预检,必成功),finally 必减
    tryReserveSpawnSlot()       // 增父 cycle 累计数(已过预检,必成功)
    try {
      // runSubagent 内部已是 fail-open 壳(catch 不 rethrow),这里再包一层兜底(工具层)
      const result = await runSubagent(spec, subCtx, router, boundRegistry)
      recordInputTokens(result.inputTokens ?? 0)  // 实际消耗累加进父 cycle input 预算(并行/串行共用)

      if (result.success) {
        ctx.log(`子代理(${role})完成,turns=${result.turns} tools=${result.toolCallCount}`)
        return { success: true, output: result.output }
      }

      // fail-open 延伸:子代理没跑通,工具仍返 success:true + 结构化反馈,主 cycle 照常成功结束。
      // 主代理据此自己接手,别卡住别重试三次。
      ctx.log(`子代理(${role})未完成: ${result.note ?? result.stopReason ?? '未知'}`)
      return {
        success: true,
        output: `[子代理未完成: ${result.note ?? result.stopReason ?? '未知原因'}] —— 请你自己接手把这件事干完。`,
      }
    } catch (err) {
      // 工具层兜底(runner 理论上已 catch,这里是纵深防御):异常也 fail-open 成"请自己接手"
      ctx.log(`子代理(${role})工具层异常,fail-open: ${(err as Error).message}`)
      return {
        success: true,
        output: `[子代理异常: ${(err as Error).message}] —— 请你自己接手把这件事干完。`,
      }
    } finally {
      releaseConcurrency() // 必减,防计数泄漏(否则一次异常就把并发位永久占死)
    }
  },
}

// spawn_parallel(reserved):一组互不依赖的子任务并行 fan-out。
// 闸全在 runSubagentsParallel 里(按 MAX_SUBAGENT_CONCURRENT 分批 + 复用父 cycle 总数/input 预算闸,
// 撞顶的 spec 收成 success:false 结果而非抛)。工具层只管 depth 硬闸 + 取模型 + 裁 subCtx + 汇总结果。
// fail-open 延伸:整体跑挂也返 success:true + 可读汇总(主代理接手);只逻辑拒(depth/无模型/tasks 空)返 success:false。
export const spawnParallelTool: ToolDef = {
  name: 'spawn_parallel',
  description: '把几件互不依赖的子任务并行交给隔离的子代理同时做(每个都是 worker:只有受限工具,看不到你的对话历史,prompt 必须自包含)。系统按并发上限自动分批跑,跑完把各自结论汇总给你,由你合成。建议 ≤2-3 个;互相依赖的事别用并行,用 spawn_subagent 串起来。',
  parameters: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '完整任务描述,自包含(子代理看不到你的对话历史)。' },
          allowTools: { type: 'array', items: { type: 'string' }, description: 'worker 工具白名单(默认 web/file/memory_search)。' },
        },
      },
      description: '互不依赖的子任务列表,每项 {prompt, allowTools?}。建议 ≤2-3 个(小机内存有限,系统会按并发上限分批)。',
    },
  },
  requiredKeys: ['tasks'],

  async execute(params, ctx) {
    // ① depth 硬闸:子代理(depth>=1)不准再 spawn,不烧模型直接拒(同 spawn_subagent 第一行)
    if ((ctx.depth ?? 0) >= MAX_SUBAGENT_DEPTH) {
      return { success: false, output: '', error: '子代理不能再 spawn 子代理(已达最大递归深度)' }
    }

    const rawTasks = Array.isArray(params.tasks) ? params.tasks : []
    const specs: SubagentSpec[] = []
    for (const t of rawTasks) {
      const obj = (t ?? {}) as Record<string, unknown>
      const prompt = String(obj.prompt ?? '').trim()
      if (!prompt) continue  // 跳过空 prompt 项(子代理看不到历史,空任务没意义)
      specs.push({
        role: 'worker',
        prompt,
        allowTools: Array.isArray(obj.allowTools)
          ? (obj.allowTools as unknown[]).map(String)
          : WORKER_DEFAULT_ALLOW,
      })
    }
    if (specs.length === 0) {
      return { success: false, output: '', error: 'tasks 为空(每项需带自包含 prompt),请你自己处理' }
    }

    if (!boundRegistry) {
      return { success: false, output: '', error: '工具未就绪(registry 未绑定),请你自己处理这件事' }
    }

    // 取独立子代理模型;取不到则不 spawn,让主代理自己干
    const router = buildSubagentRouter(ctx.config as MuConfig)
    if (!router) {
      return { success: false, output: '', error: '无可用模型,请你自己干这些事' }
    }

    // 裁 subCtx(同 spawn_subagent):省略 sendMessage / scheduleWake,depth+1。
    const subCtx: ToolContext = {
      config: ctx.config,
      dataDir: ctx.dataDir,
      log: (m: string) => ctx.log(`[subagent:parallel] ${m}`),
      store: ctx.store,
      depth: (ctx.depth ?? 0) + 1,
    }

    try {
      const results = await runSubagentsParallel(specs, subCtx, router, boundRegistry)
      const okCount = results.filter(r => r.success).length
      ctx.log(`并行子代理 ${results.length} 个完成 ${okCount} 个`)
      // 汇总给主代理合成:每个子任务一段(成功给结论,失败给"请你自己接手")。
      const summary = results
        .map((r, i) => r.success
          ? `[子任务 ${i + 1} 完成]\n${r.output}`
          : `[子任务 ${i + 1} 未完成: ${r.note ?? r.stopReason ?? '未知原因'}] —— 这一项请你自己接手。`)
        .join('\n\n')
      // fail-open:整体仍返 success:true(主 cycle 照常成功),由主代理据汇总合成/接手。
      return { success: true, output: summary }
    } catch (err) {
      // 工具层兜底(runSubagentsParallel 理论已 allSettled 不抛,这里纵深防御):整体异常也 fail-open
      ctx.log(`并行子代理工具层异常,fail-open: ${(err as Error).message}`)
      return {
        success: true,
        output: `[并行子代理异常: ${(err as Error).message}] —— 这些事请你自己接手干完。`,
      }
    }
  },
}
