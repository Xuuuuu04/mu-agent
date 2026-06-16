// WebhookGateway 的构造选项,gateway 和 admin-api 共用。
import type { MemoryStore } from '../../memory/store.js'

export interface WebhookOpts {
  port?: number
  store?: MemoryStore
  webDir?: string
  soulDir?: string
  dataDir?: string
  configPath?: string
  logDir?: string
  getTools?: () => string[]
  // agent 心跳信息(最后成功 cycle/连续失败数/下次唤醒),没有它 pm2 online ≠ 沐活着
  getAgentHealth?: () => Record<string, unknown>
}
