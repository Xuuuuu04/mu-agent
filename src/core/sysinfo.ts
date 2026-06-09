import { statfsSync } from 'node:fs'
import os from 'node:os'
import { execSync } from 'node:child_process'

export interface SysInfo {
  agentUptime: string   // 沐自己跑了多久
  systemUptime: string  // 机器开机多久
  diskUsedPct: number | null
  memUsedPct: number
  load1: number
  gpuTemp: number | null
}

// 系统状态,注入 L1 让沐知道"自己住的机器现在怎么样"。跨 mac/linux。
export function getSysInfo(rootPath = '/'): SysInfo {
  let diskUsedPct: number | null = null
  try {
    const s = statfsSync(rootPath)
    const total = s.blocks
    const avail = s.bavail
    if (total > 0) diskUsedPct = Math.round((1 - avail / total) * 100)
  } catch { /* statfs 不支持就算了 */ }

  const memUsedPct = Math.round((1 - os.freemem() / os.totalmem()) * 100)
  const load1 = Math.round((os.loadavg()[0] ?? 0) * 100) / 100

  return {
    agentUptime: formatDuration(process.uptime()),
    systemUptime: formatDuration(os.uptime()),
    diskUsedPct,
    memUsedPct,
    load1,
    gpuTemp: readGpuTemp(),
  }
}

// 一行紧凑摘要,直接进 prompt
export function formatSysInfo(info: SysInfo): string {
  const parts: string[] = []
  if (info.gpuTemp !== null) parts.push(`GPU ${info.gpuTemp}°C`)
  if (info.diskUsedPct !== null) parts.push(`磁盘 ${info.diskUsedPct}%`)
  parts.push(`内存 ${info.memUsedPct}%`)
  parts.push(`负载 ${info.load1}`)
  parts.push(`已运行 ${info.agentUptime}`)
  return parts.join(' / ')
}

let gpuChecked = false
let gpuAvailable = false

// nvidia-smi 能读就读 GPU 温度(xpark 有卡),mac/无卡环境直接跳过且只探测一次
function readGpuTemp(): number | null {
  if (gpuChecked && !gpuAvailable) return null
  try {
    const out = execSync('nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader,nounits', {
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    gpuChecked = true
    gpuAvailable = true
    const temp = parseInt(out.trim().split('\n')[0] ?? '')
    return Number.isFinite(temp) ? temp : null
  } catch {
    gpuChecked = true
    gpuAvailable = false
    return null
  }
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}秒`
  if (seconds < 3600) return `${Math.round(seconds / 60)}分钟`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}小时`
  return `${Math.round(seconds / 86400)}天`
}
