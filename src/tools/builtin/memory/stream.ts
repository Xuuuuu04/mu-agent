// 意识流备注:她给自己留一条备忘。靠 _stream_entry 侧信道把内容传给 agent-loop —
// agent-loop 是这个字段的唯一消费点(不接的话备注一条都落不了盘,见 06-09 事故)。
import type { ToolDef } from '../../../core/types.js'
import type { ToolResult } from './_shared.js'

export const streamNoteTool: ToolDef = {
  name: 'stream_note',
  description: '给自己的意识流写一条备注,下次醒来能看到',
  parameters: {
    note: { type: 'string', description: '备注内容' },
    activity_type: {
      type: 'string',
      description: '活动类型: learning/browsing/writing/task/chat/rest/other',
      required: false as unknown as string,
    },
  },
  async execute(params) {
    return {
      success: true,
      output: `备注: ${params.note}`,
      _stream_entry: { content: params.note, activity_type: params.activity_type },
    } as ToolResult & { _stream_entry: { content: string; activity_type?: string } }
  },
}
