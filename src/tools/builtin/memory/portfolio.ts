// 真实持仓管理(区别于 mx_moni 模拟盘)。用户说"买了 X"→ portfolio_add 落盘,
// relations 层每轮注入上下文,watchdog 据此拉现价比 stop_loss/take_profit。
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolDef, Position } from '../../../core/types.js'
import { ensureDir } from './_shared.js'
import { atomicWriteJsonSync } from '../../../core/atomic-file.js'

const PORTFOLIO = 'memory/portfolio.json'

function load(dataDir: string): Position[] {
  const path = join(dataDir, PORTFOLIO)
  if (!existsSync(path)) return []
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Position[]
  } catch {
    return []
  }
}

function save(dataDir: string, positions: Position[]): void {
  const path = join(dataDir, PORTFOLIO)
  ensureDir(path)
  atomicWriteJsonSync(path, positions, 2)
}

function toNum(v: unknown): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

// portfolio_add:新建一只,或同 code 加仓(数量相加、成本按加权平均合并)。
export const portfolioAddTool: ToolDef = {
  name: 'portfolio_add',
  description: '记录真实持仓(真实账户,不是模拟盘)。新建或加仓。用户说"买了/加仓 X"时用',
  parameters: {
    code: { type: 'string', description: '证券代码,如 003816' },
    name: { type: 'string', description: '名称,如 中国广核' },
    qty: { type: 'number', description: '股数' },
    cost: { type: 'number', description: '本次买入价(加仓时按加权平均合并成本)' },
    stop_loss: { type: 'number', description: '止损价(可稍后 update 补)', required: false as unknown as number },
    take_profit: { type: 'number', description: '止盈价(可稍后 update 补)', required: false as unknown as number },
    note: { type: 'string', description: '备注(策略/理由)', required: false as unknown as string },
  },
  async execute(params, ctx) {
    const code = String(params.code ?? '').trim()
    const name = String(params.name ?? '').trim()
    const qty = toNum(params.qty)
    const cost = toNum(params.cost)
    if (!code || !name) return { success: false, output: '', error: '需要 code 和 name' }
    if (!qty || qty <= 0) return { success: false, output: '', error: 'qty 必须是正数' }
    if (cost == null || cost <= 0) return { success: false, output: '', error: 'cost 必须是正数' }

    const positions = load(ctx.dataDir)
    const existing = positions.find(p => p.code === code && p.status === 'active')
    const now = new Date().toISOString()
    if (existing) {
      // 加仓:加权平均成本
      const totalQty = existing.qty + qty
      existing.cost = Number((((existing.cost * existing.qty) + (cost * qty)) / totalQty).toFixed(4))
      existing.qty = totalQty
      if (params.stop_loss != null) existing.stop_loss = toNum(params.stop_loss)
      if (params.take_profit != null) existing.take_profit = toNum(params.take_profit)
      if (params.note != null) existing.note = String(params.note)
      existing.updated = now
      save(ctx.dataDir, positions)
      ctx.log(`持仓加仓: ${name} ${code} → ${existing.qty}股@${existing.cost}`)
      return { success: true, output: `加仓后 ${name}: ${existing.qty}股@${existing.cost}(加权成本)` }
    }

    const pos: Position = {
      id: `p${Date.now().toString(36)}`,
      code, name, qty, cost,
      stop_loss: toNum(params.stop_loss),
      take_profit: toNum(params.take_profit),
      note: params.note ? String(params.note) : undefined,
      status: 'active',
      updated: now,
    }
    positions.push(pos)
    save(ctx.dataDir, positions)
    ctx.log(`持仓记下了: ${name} ${code} ${qty}股@${cost}`)
    return { success: true, output: `记下了: ${name} ${code} ${qty}股@${cost}${pos.stop_loss ? ` 止损${pos.stop_loss}` : ''}${pos.take_profit ? ` 止盈${pos.take_profit}` : ''}` }
  },
}

// portfolio_update:按 id 改字段(止损/止盈/数量/成本/备注/清仓)。
export const portfolioUpdateTool: ToolDef = {
  name: 'portfolio_update',
  description: '改一条持仓(设止损止盈、改数量成本、清仓)。按 id 改',
  parameters: {
    id: { type: 'string', description: '持仓 ID' },
    qty: { type: 'number', description: '改后股数', required: false as unknown as number },
    cost: { type: 'number', description: '改后成本价', required: false as unknown as number },
    stop_loss: { type: 'number', description: '止损价', required: false as unknown as number },
    take_profit: { type: 'number', description: '止盈价', required: false as unknown as number },
    note: { type: 'string', description: '备注', required: false as unknown as string },
    close: { type: 'boolean', description: 'true=清仓(标 closed)', required: false as unknown as boolean },
  },
  async execute(params, ctx) {
    const positions = load(ctx.dataDir)
    const target = positions.find(p => p.id === params.id)
    if (!target) return { success: false, output: '', error: `找不到持仓 ${params.id}` }

    if (params.close === true) {
      target.status = 'closed'
      target.updated = new Date().toISOString()
      save(ctx.dataDir, positions)
      return { success: true, output: `已清仓: ${target.name} ${target.code}` }
    }
    if (params.qty != null) target.qty = toNum(params.qty) ?? target.qty
    if (params.cost != null) target.cost = toNum(params.cost) ?? target.cost
    if (params.stop_loss != null) target.stop_loss = toNum(params.stop_loss)
    if (params.take_profit != null) target.take_profit = toNum(params.take_profit)
    if (params.note != null) target.note = String(params.note)
    target.updated = new Date().toISOString()
    save(ctx.dataDir, positions)
    return { success: true, output: `已更新: ${target.name} ${target.code}` }
  },
}

// portfolio_remove:硬删除一条(误录/不要留 closed 记录时用)。一般清仓用 update close。
export const portfolioRemoveTool: ToolDef = {
  name: 'portfolio_remove',
  description: '彻底删除一条持仓记录(误录时用;正常清仓请用 portfolio_update close=true)',
  parameters: {
    id: { type: 'string', description: '持仓 ID' },
  },
  async execute(params, ctx) {
    const positions = load(ctx.dataDir)
    const idx = positions.findIndex(p => p.id === params.id)
    if (idx === -1) return { success: false, output: '', error: `找不到持仓 ${params.id}` }
    const [removed] = positions.splice(idx, 1)
    save(ctx.dataDir, positions)
    return { success: true, output: `已删除: ${removed!.name} ${removed!.code}` }
  },
}
