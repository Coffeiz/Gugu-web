import { parentPort, workerData } from 'node:worker_threads'
import { dataContext, CoreError } from '../contracts/index.js'
import type { Fields } from '../contracts/index.js'
import { initializeSqlite, openSqliteRuntime } from '../data/sqlite.js'
import { execute, isMutation, validateCommandParams } from './commands.js'

interface Job {
  id: number
  method: string
  params: Fields
  operationId?: string
  cancel: SharedArrayBuffer
  deadline: number
}
const port = parentPort!
try {
  const config = workerData as { database: string; initialize: boolean; allowLegacySchema: boolean }
  if (config.initialize) await initializeSqlite(config.database)
  const { runtime, ownerId, schemaVersion } = await openSqliteRuntime(config.database, {
    allowLegacySchema: config.allowLegacySchema,
  })
  const context = dataContext(ownerId)
  port.postMessage({ event: 'ready', ownerId, schemaVersion })
  let queue = Promise.resolve()
  port.on('message', (job: Job) => {
    queue = queue.then(async () => {
      try {
        if (job.method === 'runtime.close') {
          await runtime.close()
          port.postMessage({ id: job.id, result: null })
          port.close()
          return
        }
        const flag = new Int32Array(job.cancel)
        const signal = {
          get aborted(): boolean {
            return Atomics.load(flag, 0) !== 0 || Date.now() >= job.deadline
          },
        }
        if (signal.aborted) throw new CoreError('cancelled', '操作已取消')
        let result: unknown
        if (job.method === 'operations.get') {
          validateCommandParams(job.method, job.params)
          const operationId = job.params.operation_id
          if (typeof operationId !== 'string')
            throw new CoreError('invalid_request', '操作标识必须是文本')
          result = await runtime.receipt(context, operationId)
        } else if (job.operationId && isMutation(job.method))
          result = await runtime.operation(
            context,
            job.operationId,
            job.method,
            job.params,
            (data) => execute(data, job.method, job.params),
            { signal },
          )
        else
          result = await runtime.transaction(
            context,
            (data) => execute(data, job.method, job.params),
            { signal },
          )
        port.postMessage({ id: job.id, result })
      } catch (error) {
        port.postMessage({
          id: job.id,
          error:
            error instanceof CoreError
              ? { code: error.code, message: error.message }
              : { code: 'storage_error', message: '本地数据操作失败' },
        })
      }
    })
  })
} catch (error) {
  port.postMessage({
    event: 'failed',
    error:
      error instanceof CoreError
        ? { code: error.code, message: error.message }
        : { code: 'storage_error', message: '本地数据无法打开，请检查版本与文件权限' },
  })
  port.close()
}
