import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig } from './config.js'

// 在临时 projectRoot 下写 config/config.yaml,跑 loadConfig,finally 清理。
// loadConfig 从 <root>/config/config.yaml 读;不存在则拷 example,这里总写好 config.yaml 走主路径。
function withConfig(
  yaml: string,
  fn: (root: string) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), 'mu-cfg-'))
  try {
    mkdirSync(join(root, 'config'), { recursive: true })
    writeFileSync(join(root, 'config', 'config.yaml'), yaml)
    fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// 最小合法 config:只有 model.primary 三件套(name/format/base_url/api_key/model)
const minimalYaml = `
model:
  primary:
    name: glm
    format: openai
    base_url: https://example.com/api
    api_key: sk-real-key
    model: glm-5.1
`

test('loadConfig: 最小合法配置加载成功', () => {
  withConfig(minimalYaml, (root) => {
    const cfg = loadConfig(root)
    assert.equal(cfg.model.primary.name, 'glm')
    assert.equal(cfg.model.primary.base_url, 'https://example.com/api')
  })
})

test('loadConfig: 缺 scheduler 段给默认值兜底', () => {
  withConfig(minimalYaml, (root) => {
    const cfg = loadConfig(root)
    assert.equal(cfg.scheduler.min_wake_seconds, 300)
    assert.equal(cfg.scheduler.max_wake_seconds, 14400)
    assert.equal(cfg.scheduler.cron_fallback_seconds, 7200)
    assert.equal(cfg.scheduler.night_min_wake_seconds, 3600)
    assert.equal(cfg.scheduler.night_start_hour, 1)
    assert.equal(cfg.scheduler.night_end_hour, 7)
  })
})

test('loadConfig: 缺 agent 段给默认值兜底', () => {
  withConfig(minimalYaml, (root) => {
    const cfg = loadConfig(root)
    assert.equal(cfg.agent.max_turns_per_cycle, 20)
    assert.equal(cfg.agent.session_timeout_minutes, 30)
  })
})

test('loadConfig: scheduler 部分字段保留用户值,其余补默认', () => {
  const yaml = minimalYaml + `
scheduler:
  min_wake_seconds: 120
`
  withConfig(yaml, (root) => {
    const cfg = loadConfig(root)
    assert.equal(cfg.scheduler.min_wake_seconds, 120, '用户值保留')
    assert.equal(cfg.scheduler.max_wake_seconds, 14400, '未给的补默认')
  })
})

test('loadConfig: paths 解析为相对 projectRoot 的绝对路径', () => {
  withConfig(minimalYaml, (root) => {
    const cfg = loadConfig(root)
    assert.equal(cfg.paths.soul, resolve(root, './soul'))
    assert.equal(cfg.paths.data, resolve(root, './data'))
    assert.equal(cfg.paths.tools, resolve(root, './data/tools'))
  })
})

test('loadConfig: 自定义 paths.data 也按 root 解析', () => {
  const yaml = minimalYaml + `
paths:
  data: ./custom-data
`
  withConfig(yaml, (root) => {
    const cfg = loadConfig(root)
    assert.equal(cfg.paths.data, resolve(root, './custom-data'))
    // tools 没给,仍走默认 ./data/tools(不跟 data 走)
    assert.equal(cfg.paths.tools, resolve(root, './data/tools'))
  })
})

// ---- 校验抛错路径 ----

test('loadConfig: 缺 model.primary 抛错', () => {
  const yaml = `
model:
  fallback: []
`
  withConfig(yaml, (root) => {
    assert.throws(() => loadConfig(root), /model\.primary 必须配置/)
  })
})

test('loadConfig: api_key 是占位符 YOUR_API_KEY_HERE 抛错', () => {
  const yaml = `
model:
  primary:
    name: glm
    format: openai
    base_url: https://example.com/api
    api_key: YOUR_API_KEY_HERE
    model: glm-5.1
`
  withConfig(yaml, (root) => {
    assert.throws(() => loadConfig(root), /请在.*填入 API key/)
  })
})

test('loadConfig: 缺 base_url 抛错', () => {
  const yaml = `
model:
  primary:
    name: glm
    format: openai
    api_key: sk-real-key
    model: glm-5.1
`
  withConfig(yaml, (root) => {
    assert.throws(() => loadConfig(root), /base_url 必须配置/)
  })
})

test('loadConfig: config.yaml 为空内容抛错', () => {
  withConfig('', (root) => {
    assert.throws(() => loadConfig(root), /为空或格式错误/)
  })
})

test('loadConfig: config.yaml 不存在且无 example 抛找不到', () => {
  // 建一个 root,只放空 config/ 目录(无 config.yaml 无 example)
  const root = mkdtempSync(join(tmpdir(), 'mu-cfg-'))
  try {
    mkdirSync(join(root, 'config'), { recursive: true })
    assert.throws(() => loadConfig(root), /找不到配置文件/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('loadConfig: config.yaml 缺失则从 example 拷贝后再读', () => {
  const root = mkdtempSync(join(tmpdir(), 'mu-cfg-'))
  try {
    mkdirSync(join(root, 'config'), { recursive: true })
    // 只放 example,不放 config.yaml → loadConfig 应拷贝出 config.yaml 再加载
    writeFileSync(join(root, 'config', 'config.example.yaml'), minimalYaml)
    const cfg = loadConfig(root)
    assert.equal(cfg.model.primary.name, 'glm')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
