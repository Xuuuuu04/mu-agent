#!/usr/bin/env node
// 管理 CLI:连到 Shion(webhook :3210)查状态/记忆/日志,或手动唤醒。
// `mu chat` 直接拉起守护进程。其它子命令是 HTTP 客户端,不会再开一个实例。
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'

// 服务绑 127.0.0.1(IPv4 回环)，这里也用 127.0.0.1，避免 localhost 解析到 ::1 连不上
const API = process.env.MU_API ?? 'http://127.0.0.1:3210'
const PROJECT_ROOT = resolve(import.meta.dirname, '..')
const cmd = process.argv[2] ?? 'help'
const arg = process.argv.slice(3).join(' ')

async function get(path: string): Promise<unknown> {
  const r = await fetch(`${API}${path}`)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}
async function post(path: string, body: unknown): Promise<unknown> {
  const r = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

function die(msg: string): never {
  console.error(msg)
  process.exit(1)
}

async function main(): Promise<void> {
  switch (cmd) {
    case 'chat': {
      // 拉起守护进程(等同 npm start)
      const child = spawn('npx', ['tsx', resolve(PROJECT_ROOT, 'src/mu.ts')], { stdio: 'inherit' })
      child.on('exit', (code) => process.exit(code ?? 0))
      break
    }

    case 'status': {
      try {
        const s = await get('/api/status') as Record<string, unknown>
        const mood = s.mood as { current?: string; reason?: string } | null
        console.log(`Shion v${s.version}`)
        console.log(`  心情: ${mood?.current ?? '?'} ${mood?.reason ? `(${mood.reason})` : ''}`)
        console.log(`  记忆: ${s.episodes} 条`)
        console.log(`  运行: ${formatUptime(s.uptime as number)} / 内存 ${s.memory_rss}MB`)
      } catch (e) {
        die(`连不上 Shion(${API})，服务是否已启动？ ${(e as Error).message}`)
      }
      break
    }

    case 'memory': {
      if (!arg) die('用法: mu memory <关键词>')
      const d = await get(`/api/memory?q=${encodeURIComponent(arg)}`) as { results?: Array<{ timestamp: string; role: string; content: string }> }
      const results = d.results ?? []
      if (results.length === 0) { console.log('没找到'); break }
      for (const r of results) {
        const t = new Date(r.timestamp).toLocaleString('zh-CN')
        console.log(`[${t}] ${r.role === 'user' ? '用户' : 'Shion'}: ${r.content.slice(0, 80)}`)
      }
      break
    }

    case 'wake': {
      await post('/webhook/event', { event: 'manual_wake' })
      console.log('叫醒了')
      break
    }

    case 'logs': {
      const d = await get(`/api/logs?lines=${arg || '50'}`) as { logs?: string[] }
      for (const line of d.logs ?? []) console.log(line)
      break
    }

    case 'config': {
      const path = resolve(PROJECT_ROOT, 'config', 'config.yaml')
      if (!existsSync(path)) die('config.yaml 不存在')
      // 本地直接读文件(含密钥),不走 HTTP
      const text = readFileSync(path, 'utf-8').replace(/((?:api_key|token|secret|password|self_wxid):\s*)\S+/gi, '$1***')
      console.log(text)
      break
    }

    default:
      console.log(`Shion 管理 CLI

  mu chat           启动 Shion(守护进程)
  mu status         看状态(心情/记忆/运行)
  mu memory <词>    搜记忆
  mu wake           手动叫醒
  mu logs [行数]    看日志
  mu config         看配置(密钥已打码)

需要 Shion 在运行(mu chat 或 pnpm start)，管理命令才能连接。`)
  }
}

main().catch((e) => die((e as Error).message))

function formatUptime(s: number): string {
  if (s < 60) return `${Math.round(s)}秒`
  if (s < 3600) return `${Math.round(s / 60)}分钟`
  if (s < 86400) return `${Math.round(s / 3600)}小时`
  return `${Math.round(s / 86400)}天`
}
