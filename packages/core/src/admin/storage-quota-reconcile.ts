export class StorageQuotaScanBusy extends Error {
  readonly code = 'storage_quota_scan_busy'
  constructor() { super('存储容量校准繁忙，请稍后重试') }
}

export const UNLIMITED_STORAGE_BYTES = '9223372036854775807'

/** 用户 -1 表示不限额，null 继承系统默认，系统默认 null 也表示不限额。 */
export function resolveFileLibraryLimit(userLimit: string | number | null, defaultLimit: string | number | null): string {
  const normalize = (value: string | number): bigint => {
    const text = String(value)
    if (!/^-?\d+$/.test(text)) throw new RangeError('存储配额上限无效')
    const number = BigInt(text)
    if (number < -1n || number > BigInt(UNLIMITED_STORAGE_BYTES)) throw new RangeError('存储配额上限无效')
    return number
  }
  const user = userLimit === null ? null : normalize(userLimit)
  if (user === -1n) return UNLIMITED_STORAGE_BYTES
  if (user !== null) return String(user)
  const fallback = defaultLimit === null ? null : normalize(defaultLimit)
  if (fallback === null || fallback === -1n) return UNLIMITED_STORAGE_BYTES
  return String(fallback)
}

export interface StorageQuotaReconcileProgress {
  total: number
  processed: number
  completed: number
  failed: number
}

export interface StorageQuotaReconcilePort {
  /** 管理员手动全量校准包含全部用户，含停用用户。 */
  listUserIds(): Promise<readonly string[]>
  /** 完成扫描并以并发保护的事务应用账本修正。 */
  reconcileUser(userId: string, signal: AbortSignal): Promise<void>
}

export interface StorageQuotaReconcileOptions {
  concurrency?: number
  maxBusyAttempts?: number
  retryDelayMs?: number
  signal?: AbortSignal
  onProgress?(progress: StorageQuotaReconcileProgress): Promise<void> | void
  onUserError?(error: unknown): void
  wait?(milliseconds: number, signal: AbortSignal): Promise<void>
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || milliseconds <= 0) return Promise.resolve()
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
    const timer = setTimeout(finish, milliseconds)
    signal.addEventListener('abort', finish, { once: true })
  })
}

/** 限并发、逐用户隔离失败并发布兼容 Python 的人工全量校准进度。 */
export async function reconcileAllStorageUsers(
  port: StorageQuotaReconcilePort,
  options: StorageQuotaReconcileOptions = {},
): Promise<StorageQuotaReconcileProgress> {
  const concurrency = options.concurrency ?? 4
  const maxBusyAttempts = options.maxBusyAttempts ?? 3
  const retryDelayMs = options.retryDelayMs ?? 5_000
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32
    || !Number.isSafeInteger(maxBusyAttempts) || maxBusyAttempts < 1
    || !Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0) throw new RangeError('存储配额对账参数无效')
  const signal = options.signal ?? new AbortController().signal
  const userIds = await port.listUserIds()
  const progress: StorageQuotaReconcileProgress = { total: userIds.length, processed: 0, completed: 0, failed: 0 }
  const progressLock = { pending: Promise.resolve() }
  const report = async () => {
    if (!options.onProgress) return
    const snapshot = { ...progress }
    const next = progressLock.pending.then(() => options.onProgress!(snapshot))
    progressLock.pending = next.catch(() => undefined)
    await next
  }
  await report()
  let cursor = 0
  async function worker(): Promise<void> {
    while (!signal.aborted) {
      const index = cursor++
      if (index >= userIds.length) return
      const userId = userIds[index]!
      let succeeded = false
      for (let attempt = 1; attempt <= maxBusyAttempts && !signal.aborted; attempt += 1) {
        try {
          await port.reconcileUser(userId, signal)
          succeeded = true
          break
        } catch (error) {
          if (signal.aborted) return
          if (!(error instanceof StorageQuotaScanBusy) || attempt === maxBusyAttempts) {
            try { options.onUserError?.(error) } catch { /* 单用户诊断不得中断全量任务。 */ }
            break
          }
          await (options.wait ?? delay)(retryDelayMs, signal)
        }
      }
      if (signal.aborted) return
      progress.processed += 1
      if (succeeded) progress.completed += 1
      else progress.failed += 1
      await report()
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, userIds.length || 1) }, worker))
  await progressLock.pending
  return { ...progress }
}
