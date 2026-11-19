import { closeSync, constants, fchmodSync, openSync } from 'node:fs'
import { createRequire } from 'node:module'

interface FfiLibrary { functions: { flock(fd: number, operation: number): number } }
const LOCK_EX = 2, LOCK_NB = 4, LOCK_UN = 8
const require = createRequire(import.meta.url)
let library: FfiLibrary | undefined
/** 只检查本机能力，不打开或创建用户配置及锁文件。 */
export function assertPosixConfigLockAvailable(): void {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('当前平台不支持 POSIX 配置锁')
  if (Number(process.versions.node.split('.')[0]) < 26) throw new Error('POSIX 配置锁需要 Node.js 26 或更高版本')
  if (!library) {
    try { library = (require('node:ffi') as { dlopen(name: null, symbols: object): FfiLibrary }).dlopen(null, { flock: { arguments: ['i32', 'i32'], return: 'i32' } }) }
    catch { throw new Error('POSIX 配置锁不可用：Node.js FFI 被禁用、受权限限制或系统缺少 flock') }
  }
  if (typeof library.functions?.flock !== 'function') throw new Error('POSIX 配置锁不可用：系统缺少 flock')
}
function flock(fd: number, operation: number): number {
  assertPosixConfigLockAvailable()
  if (!library) throw new Error('POSIX 配置锁不可用')
  try { return library.functions.flock(fd, operation) }
  catch { throw new Error('POSIX 配置锁调用失败：FFI 权限不足或系统不支持') }
}
function openLock(path: string): number {
  if (!path) throw new TypeError('配置锁路径无效')
  let fd: number
  try { fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600) }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ELOOP') throw new Error('配置锁文件不能是符号链接')
    if (code === 'EACCES' || code === 'EPERM') throw new Error('没有权限打开配置锁文件')
    if (code === 'ENOENT') throw new Error('配置锁目录不存在')
    throw new Error('无法打开配置锁文件')
  }
  try { fchmodSync(fd, 0o600); return fd } catch { closeSync(fd); throw new Error('无法设置配置锁文件权限') }
}
function unlock(fd: number): void {
  try { if (flock(fd, LOCK_UN) !== 0) throw new Error('配置锁释放失败') } finally { closeSync(fd) }
}
/** 同步操作立即尝试 flock，避免在事件循环中阻塞其他持锁任务。 */
export function createPosixConfigFileLock(timeoutMs = 10000, retryMs = 25) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(retryMs) || retryMs < 1) throw new RangeError('配置锁等待时间无效')
  assertPosixConfigLockAvailable()
  return {
    exclusive<T>(path: string, work: () => T): T {
      const fd = openLock(path)
      let locked = false, deferredClose = false
      try {
        if (flock(fd, LOCK_EX | LOCK_NB) !== 0) throw new Error('配置正在被其他进程修改')
        locked = true
        const value = work()
        if (value && typeof (value as { then?: unknown }).then === 'function') {
          locked = false
          deferredClose = true
          void Promise.resolve(value).finally(() => unlock(fd)).catch(() => {})
          throw new TypeError('同步配置锁回调不能是异步函数')
        }
        return value
      } finally { if (locked) unlock(fd); else if (!deferredClose) closeSync(fd) }
    },
    async withExclusive<T>(path: string, work: () => Promise<T>): Promise<T> {
      const fd = openLock(path), deadline = Date.now() + timeoutMs
      let locked = false
      try {
        do {
          if (flock(fd, LOCK_EX | LOCK_NB) === 0) { locked = true; break }
          if (Date.now() >= deadline) throw new Error('等待配置锁超时')
          await new Promise(resolve => setTimeout(resolve, Math.min(retryMs, Math.max(1, deadline - Date.now()))))
        } while (true)
        return await work()
      } finally { if (locked) unlock(fd); else closeSync(fd) }
    },
  }
}
