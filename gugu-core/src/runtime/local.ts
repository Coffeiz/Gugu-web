import { Worker } from 'node:worker_threads'
import { resolve } from 'node:path'
import { CoreError } from '../contracts/index.js'
import type { ErrorCode, Fields } from '../contracts/index.js'

interface Pending {
  resolve(value: unknown): void
  reject(reason: unknown): void
  flag: Int32Array
  dispose(): void
}
interface CallOptions {
  operationId?: string
  signal?: AbortSignal
  timeoutMs?: number
}
interface Startup {
  event: string
  ownerId: string
  schemaVersion: string
  error?: { code: ErrorCode; message: string }
}
export class LocalRuntime {
  private pending = new Map<number, Pending>()
  private sequence = 0
  private closed = false
  private healthy = true
  private closing?: Promise<void>
  readonly ownerId: string
  readonly schemaVersion: string
  private constructor(
    private worker: Worker,
    info: { ownerId: string; schemaVersion: string },
  ) {
    this.ownerId = info.ownerId
    this.schemaVersion = info.schemaVersion
    worker.on(
      'message',
      (frame: {
        id: number
        result?: unknown
        error?: { code: ErrorCode; message: string }
      }) => {
        const pending = this.pending.get(frame.id)
        if (!pending) return
        this.pending.delete(frame.id)
        pending.dispose()
        if (frame.error)
          pending.reject(new CoreError(frame.error.code, frame.error.message))
        else pending.resolve(frame.result)
      },
    )
    const failed = (): void => {
      this.healthy = false
      for (const pending of this.pending.values()) {
        pending.dispose()
        pending.reject(
          new CoreError('storage_error', '数据进程已停止，请重读已保存数据确认操作状态'),
        )
      }
      this.pending.clear()
    }
    worker.on('error', failed)
    worker.on('exit', failed)
  }
  private static async start(
    database: string,
    initialize: boolean,
    allowLegacySchema = false,
    exclusive = false,
  ): Promise<LocalRuntime> {
    const worker = new Worker(new URL('./worker.js', import.meta.url), {
      workerData: {
        database: resolve(database),
        initialize,
        allowLegacySchema,
        exclusive,
      },
    })
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer)
        worker.off('error', fail)
        worker.off('exit', fail)
        worker.off('message', ready)
      }
      const fail = (): void => {
        cleanup()
        void worker.terminate()
        reject(new CoreError('storage_error', 'Core 数据进程无法启动'))
      }
      const ready = (info: Startup): void => {
        cleanup()
        if (info.event !== 'ready') {
          void worker.terminate()
          reject(
            new CoreError(
              info.error?.code ?? 'storage_error',
              info.error?.message ?? 'Core 数据进程无法启动',
            ),
          )
          return
        }
        resolve(new LocalRuntime(worker, info))
      }
      const timer = setTimeout(() => {
        cleanup()
        void worker.terminate()
        reject(new CoreError('storage_error', 'Core 启动超时'))
      }, 15_000)
      worker.once('error', fail)
      worker.once('exit', fail)
      worker.once('message', ready)
    })
  }
  static initialize(
    database: string,
    options: { exclusive?: boolean } = {},
  ): Promise<LocalRuntime> {
    return this.start(database, true, false, options.exclusive ?? false)
  }
  static open(
    database: string,
    options: { allowLegacySchema?: boolean; exclusive?: boolean } = {},
  ): Promise<LocalRuntime> {
    return this.start(
      database,
      false,
      options.allowLegacySchema ?? false,
      options.exclusive ?? false,
    )
  }
  call<T = unknown>(
    method: string,
    params: Fields = {},
    options: CallOptions = {},
  ): Promise<T> {
    if (this.closed || !this.healthy)
      return Promise.reject(new CoreError('closed', '数据运行时已关闭'))
    if (method === 'runtime.close')
      return Promise.reject(new CoreError('invalid_request', '请通过 close 关闭运行时'))
    if (this.pending.size >= 128)
      return Promise.reject(new CoreError('busy', '本地数据队列已满'))
    return this.enqueue<T>(method, params, options)
  }
  private enqueue<T>(
    method: string,
    params: Fields,
    options: CallOptions = {},
  ): Promise<T> {
    if (options.signal?.aborted)
      return Promise.reject(new CoreError('cancelled', '操作已取消'))
    const id = ++this.sequence,
      flag = new Int32Array(new SharedArrayBuffer(4)),
      timeoutMs = options.timeoutMs ?? 12_000
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
      return Promise.reject(new CoreError('invalid_request', '请求时限无效'))
    return new Promise<T>((resolve, reject) => {
      const cancel = (): void => {
        Atomics.store(flag, 0, 1)
      }
      const timer = setTimeout(() => {
        cancel()
        this.healthy = false
        // 不把未知提交状态报告为已回滚；终止后可凭持久操作 ID 查询。
        void this.worker.terminate()
      }, timeoutMs + 1000)
      options.signal?.addEventListener('abort', cancel, { once: true })
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        flag,
        dispose: () => {
          clearTimeout(timer)
          options.signal?.removeEventListener('abort', cancel)
        },
      })
      try {
        this.worker.postMessage({
          id,
          method,
          params,
          operationId: options.operationId,
          cancel: flag.buffer,
          deadline: Date.now() + timeoutMs,
        })
      } catch {
        const pending = this.pending.get(id)
        pending?.dispose()
        this.pending.delete(id)
        reject(new CoreError('invalid_request', '请求包含不可传输的值'))
      }
    })
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    // 先停止业务入队，关闭控制帧保留独立容量；并发 close 等待同一轮释放。
    this.closed = true
    for (const pending of this.pending.values()) Atomics.store(pending.flag, 0, 1)
    this.closing = (async () => {
      try {
        if (this.healthy) await this.enqueue('runtime.close', {})
      } finally {
        await this.worker.terminate()
      }
    })()
    return this.closing
  }
}
