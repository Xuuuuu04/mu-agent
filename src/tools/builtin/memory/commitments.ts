// 承诺管理:创建(一次性/周期性)+ 标记完成。
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolDef, Commitment } from '../../../core/types.js'
import { absolutizeTime } from '../../../memory/absolutize.js'
import { ensureDir } from './_shared.js'

export const commitmentCreateTool: ToolDef = {
  name: 'commitment_create',
  description: '创建一个承诺或提醒。答应了要做的事、需要定期做的事用这个',
  parameters: {
    content: { type: 'string', description: '承诺内容' },
    type: { type: 'string', description: 'one-time(一次性) 或 recurring(周期性)' },
    due: { type: 'string', description: '截止日期(YYYY-MM-DD),周期性可不填', required: false as unknown as string },
    schedule: { type: 'string', description: '周期说明(如"每天中午"),一次性可不填', required: false as unknown as string },
  },
  async execute(params, ctx) {
    const commitmentsPath = join(ctx.dataDir, 'memory', 'commitments.json')
    ensureDir(commitmentsPath)

    const existing: Commitment[] = existsSync(commitmentsPath)
      ? JSON.parse(readFileSync(commitmentsPath, 'utf-8'))
      : []

    const commitment: Commitment = {
      id: `c${Date.now().toString(36)}`,
      content: absolutizeTime(params.content as string),
      type: params.type as 'one-time' | 'recurring',
      due: params.due as string | undefined,
      schedule: params.schedule as string | undefined,
      status: 'active',
      created: new Date().toISOString().slice(0, 10),
    }

    existing.push(commitment)
    writeFileSync(commitmentsPath, JSON.stringify(existing, null, 2), 'utf-8')
    ctx.log(`承诺记下了: ${commitment.content}`)
    return { success: true, output: `记下了: ${commitment.content}` }
  },
}

export const commitmentDoneTool: ToolDef = {
  name: 'commitment_done',
  description: '标记一个承诺已完成',
  parameters: {
    id: { type: 'string', description: '承诺 ID' },
  },
  async execute(params, ctx) {
    const commitmentsPath = join(ctx.dataDir, 'memory', 'commitments.json')
    if (!existsSync(commitmentsPath)) {
      return { success: false, output: '', error: '没有承诺记录' }
    }

    const commitments: Commitment[] = JSON.parse(readFileSync(commitmentsPath, 'utf-8'))
    const target = commitments.find(c => c.id === params.id)
    if (!target) {
      return { success: false, output: '', error: `找不到承诺 ${params.id}` }
    }

    // 周期性承诺完成一次不置 done,只更新 last_done(下次还要做)
    if (target.type === 'one-time') {
      target.status = 'done'
    }
    target.last_done = new Date().toISOString()

    writeFileSync(commitmentsPath, JSON.stringify(commitments, null, 2), 'utf-8')
    return { success: true, output: `完成了: ${target.content}` }
  },
}
