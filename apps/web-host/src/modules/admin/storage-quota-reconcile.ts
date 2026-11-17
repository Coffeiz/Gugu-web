import { randomUUID } from 'node:crypto'
import type { StorageQuotaReconcileProgress } from '@gugu/core/admin/storage-quota-reconcile'

export const storageQuotaStateKey = 'storage:quota_reconcile:manual_state'
export const storageQuotaLockKey = 'storage:quota_reconcile:lock'
const stateTtlSeconds = 7 * 24 * 60 * 60
const lockTtlSeconds = 15 * 60
const lockRenewMs = 5 * 60 * 1000
const fencedWrite = "if redis.call('GET',KEYS[1])==ARGV[1] then redis.call('SET',KEYS[2],ARGV[2],'EX',ARGV[3]);return 1 end;return 0"
const renewLease = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('EXPIRE',KEYS[1],ARGV[2]) end;return 0"
const releaseLease = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end;return 0"

interface RedisCommands {
  set(key: string, value: string, ...options: string[]): Promise<unknown>
  eval(script: string, keyCount: number, ...args: string[]): Promise<unknown>
}

interface StateReader { read(): Promise<string | null> }
interface ManualState extends StorageQuotaReconcileProgress {
  status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted' | 'busy'
  started_at: string | null
  updated_at?: string
  finished_at?: string
}

export class StorageQuotaReconcileUnavailable extends Error {
  constructor() { super('暂时无法启动对账') }
}

function stateFrom(raw: string | null): ManualState {
  if (!raw) return { status: 'idle' as ManualState['status'], total: 0, processed: 0, completed: 0, failed: 0, started_at: null }
  try {
    const value: unknown = JSON.parse(raw)
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as ManualState
  } catch { /* 使用空闲态，与 Python 路由一致。 */ }
  return { status: 'idle' as ManualState['status'], total: 0, processed: 0, completed: 0, failed: 0, started_at: null }
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
    const timer = setTimeout(finish, milliseconds)
    timer.unref?.()
    signal.addEventListener('abort', finish, { once: true })
  })
}

/** 与 Python 共用 Redis 租约和状态协议；工作在 Host 生命周期内执行并有租约 fencing。 */
export function createManualStorageQuotaReconcile(options: {
  commands: RedisCommands
  state: StateReader
  work(signal: AbortSignal, progress: (value: StorageQuotaReconcileProgress) => Promise<void>): Promise<StorageQuotaReconcileProgress>
  now?(): string
  renewIntervalMs?: number
  onError?(error: unknown): void
}) {
  const now = options.now ?? (() => new Date().toISOString())
  const renewInterval = options.renewIntervalMs ?? lockRenewMs
  if (!Number.isSafeInteger(renewInterval) || renewInterval < 1) throw new RangeError('配额对账租约续期必须为正整数毫秒')
  let task: Promise<void> | null = null
  let active: AbortController | null = null
  let closing = false

  async function writeState(token: string, value: ManualState): Promise<boolean> {
    return String(await options.commands.eval(fencedWrite, 2, storageQuotaLockKey, storageQuotaStateKey,
      token, JSON.stringify(value), String(stateTtlSeconds))) === '1'
  }

  async function run(token: string, initial: ManualState, controller: AbortController): Promise<void> {
    let state = initial
    const renewController = new AbortController()
    const renewal = (async () => {
      while (!renewController.signal.aborted && !controller.signal.aborted) {
        await wait(renewInterval, renewController.signal)
        if (renewController.signal.aborted || controller.signal.aborted) return
        let renewed = false
        try { renewed = String(await options.commands.eval(renewLease, 1, storageQuotaLockKey, token, String(lockTtlSeconds))) === '1' }
        catch (error) { try { options.onError?.(error) } catch { /* diagnostics cannot interrupt lease fencing. */ } }
        if (!renewed) {
          controller.abort(new Error('配额对账租约已失效'))
          return
        }
      }
    })()
    try {
      state = { ...state, status: 'running', started_at: now() }
      if (!await writeState(token, state)) controller.abort(new Error('配额对账租约已失效'))
      const result = await options.work(controller.signal, async progress => {
        state = { ...state, ...progress, updated_at: now() }
        if (!await writeState(token, state)) controller.abort(new Error('配额对账租约已失效'))
      })
      state = { ...state, ...result, status: controller.signal.aborted ? 'interrupted' : 'completed', finished_at: now() }
    } catch (error) {
      try { options.onError?.(error) } catch { /* diagnostics cannot interrupt finalization. */ }
      state = { ...state, status: controller.signal.aborted ? 'interrupted' : 'failed', finished_at: now() }
    } finally {
      renewController.abort()
      await renewal
      try { await writeState(token, state) } catch (error) { try { options.onError?.(error) } catch { /* ignored */ } }
      try { await options.commands.eval(releaseLease, 1, storageQuotaLockKey, token) }
      catch (error) { try { options.onError?.(error) } catch { /* ignored */ } }
      if (active === controller) active = null
      task = null
    }
  }

  return {
    async start(): Promise<{ started: boolean; state: ManualState }> {
      if (closing) throw new StorageQuotaReconcileUnavailable()
      const token = randomUUID()
      let acquired: string | null
      try { acquired = await options.commands.set(storageQuotaLockKey, token, 'NX', 'EX', String(lockTtlSeconds)) as string | null }
      catch { throw new StorageQuotaReconcileUnavailable() }
      if (acquired !== 'OK') {
        try {
          const current = stateFrom(await options.state.read())
          return { started: false, state: current.status === 'queued' || current.status === 'running' ? current : { status: 'busy', total: 0, processed: 0, completed: 0, failed: 0, started_at: null } }
        } catch { throw new StorageQuotaReconcileUnavailable() }
      }
      const queued: ManualState = { status: 'queued', total: 0, processed: 0, completed: 0, failed: 0, started_at: null }
      try {
        if (!await writeState(token, queued)) throw new Error('配额对账租约已失效')
      } catch {
        try { await options.commands.eval(releaseLease, 1, storageQuotaLockKey, token) } catch { /* Preserve service-unavailable response. */ }
        throw new StorageQuotaReconcileUnavailable()
      }
      const controller = new AbortController()
      active = controller
      task = Promise.resolve().then(() => run(token, queued, controller))
      return { started: true, state: queued }
    },
    async close(): Promise<void> {
      closing = true
      active?.abort(new Error('Host 正在关闭'))
      await task
    },
  }
}
