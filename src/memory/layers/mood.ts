import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { Mood, MoodState } from '../../core/types.js'
import { atomicWriteJsonSync } from '../../core/atomic-file.js'

const VALID_MOODS: Mood[] = ['calm', 'missing', 'emo', 'excited', 'sleepy', 'active']

export function loadMood(dataDir: string): MoodState | null {
  const path = join(dataDir, 'memory', 'mood.json')
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as MoodState
  } catch {
    return null
  }
}

// agent 回复里写了 [MOOD:xxx:原因] 就更新心情。记下从什么情绪转来的,L1 注入时能说"3小时前从 missing 转来"。
export function updateMood(dataDir: string, mood: string, reason: string): boolean {
  const normalized = mood.toLowerCase().trim() as Mood
  if (!VALID_MOODS.includes(normalized)) return false

  const path = join(dataDir, 'memory', 'mood.json')
  const prev = loadMood(dataDir)
  if (prev?.current === normalized) return false  // 没变就不写

  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const next: MoodState = {
    current: normalized,
    since: new Date().toISOString(),
    reason: reason || prev?.reason || '',
    previous: prev ? { mood: prev.current, changed_at: prev.since } : undefined,
  }
  atomicWriteJsonSync(path, next, 2)
  return true
}
