import { readFileSync, existsSync, copyFileSync } from 'node:fs'
import { resolve } from 'node:path'
import YAML from 'yaml'
import type { MuConfig } from './core/types.js'

export function loadConfig(projectRoot: string): MuConfig {
  const configPath = resolve(projectRoot, 'config', 'config.yaml')
  const examplePath = resolve(projectRoot, 'config', 'config.example.yaml')

  if (!existsSync(configPath)) {
    if (existsSync(examplePath)) {
      copyFileSync(examplePath, configPath)
      console.log(`[config] 已从 example 创建 config.yaml,请编辑填入 API key`)
    } else {
      throw new Error(`找不到配置文件: ${configPath}`)
    }
  }

  const raw = readFileSync(configPath, 'utf-8')
  const parsed = YAML.parse(raw) as MuConfig
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('config.yaml 为空或格式错误，请参照 config.example.yaml 填写')
  }

  parsed.paths = {
    soul: resolve(projectRoot, parsed.paths?.soul || './soul'),
    data: resolve(projectRoot, parsed.paths?.data || './data'),
    tools: resolve(projectRoot, parsed.paths?.tools || './data/tools'),
  }

  // scheduler/agent 缺字段给默认值兜底：避免缺 scheduler 段启动硬崩、
  // 缺 agent.max_turns 导致工具循环 0 轮静默返回空回复
  parsed.scheduler = {
    min_wake_seconds: 300,
    max_wake_seconds: 14400,
    max_sleep_seconds: 28800,
    cron_fallback_seconds: 7200,
    night_min_wake_seconds: 3600,
    night_start_hour: 1,
    night_end_hour: 7,
    ...((parsed.scheduler ?? {}) as Partial<MuConfig['scheduler']>),
  }
  parsed.agent = {
    max_turns_per_cycle: 20,
    session_timeout_minutes: 30,
    ...((parsed.agent ?? {}) as Partial<MuConfig['agent']>),
  }

  validate(parsed)
  return parsed
}

function validate(config: MuConfig): void {
  if (!config.model?.primary) {
    throw new Error('config: model.primary 必须配置')
  }
  if (!config.model.primary.api_key || config.model.primary.api_key === 'YOUR_API_KEY_HERE') {
    throw new Error('config: 请在 config/config.yaml 中填入 API key')
  }
  if (!config.model.primary.base_url) {
    throw new Error('config: model.primary.base_url 必须配置')
  }
  // 数值范围:负/零唤醒间隔会让她疯狂醒来,min>max 让 clamp 逻辑反转,
  // max_turns<1 让工具循环 0 轮直接返回空回复(静默"已读不回")
  const s = config.scheduler
  if (s.min_wake_seconds < 1 || s.max_wake_seconds < 1 || s.cron_fallback_seconds < 1) {
    throw new Error('config: scheduler 的唤醒间隔必须为正数')
  }
  if (s.min_wake_seconds > s.max_wake_seconds) {
    throw new Error('config: scheduler.min_wake_seconds 不能大于 max_wake_seconds')
  }
  if (s.max_sleep_seconds < s.max_wake_seconds) {
    throw new Error('config: scheduler.max_sleep_seconds 不能小于 max_wake_seconds')
  }
  if (config.agent.max_turns_per_cycle < 1) {
    throw new Error('config: agent.max_turns_per_cycle 必须 ≥1')
  }
}
