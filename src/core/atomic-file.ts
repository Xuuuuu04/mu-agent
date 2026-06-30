import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, statSync,
  unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, basename, join } from 'node:path'

// 同目录临时文件 → fsync → rename。进程在写一半时崩溃，旧文件仍完整可读。
export function atomicWriteFileSync(path: string, data: string | Buffer): void {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const temp = join(
    dir,
    `.${basename(path)}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}.tmp`,
  )
  const mode = existsSync(path) ? statSync(path).mode : 0o600
  let fd: number | null = null
  try {
    fd = openSync(temp, 'wx', mode)
    writeFileSync(fd, data)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(temp, path)
    // 尽力同步目录项；某些文件系统不支持目录 fsync，不影响 rename 的原子性。
    try {
      const dirFd = openSync(dir, 'r')
      try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
    } catch { /* best effort */ }
  } catch (err) {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* already closed */ }
    }
    try { unlinkSync(temp) } catch { /* temp may not exist */ }
    throw err
  }
}

export function atomicWriteJsonSync(path: string, value: unknown, space?: number): void {
  atomicWriteFileSync(path, JSON.stringify(value, null, space))
}
