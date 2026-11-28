import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { LocalRuntime } from '../../src/runtime/local.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

it('LocalRuntime 通过调用方注入的 Worker 入口处理请求', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-worker-entry-'))
  directories.push(directory)
  const workerEntry = join(directory, 'worker.mjs')
  await writeFile(workerEntry, `
    import { parentPort, workerData } from 'node:worker_threads'
    parentPort.postMessage({ event: 'ready', ownerId: '00000000-0000-4000-8000-000000000001', schemaVersion: 'injected' })
    parentPort.on('message', frame => parentPort.postMessage({ id: frame.id, result: {
      method: frame.method, database: workerData.database, initialize: workerData.initialize, exclusive: workerData.exclusive,
      agentRuntimeModule: workerData.agentRuntimeModule,
    } }))
  `)

  const runtime = await LocalRuntime.initialize(join(directory, 'unused.db'), {
    exclusive: true,
    workerEntry,
    agentRuntimeModule: join(directory, 'agent-runtime.mjs'),
  })
  try {
    await expect(runtime.call('adapter.probe')).resolves.toEqual({
      method: 'adapter.probe',
      database: join(directory, 'unused.db'),
      initialize: true,
      exclusive: true,
      agentRuntimeModule: join(directory, 'agent-runtime.mjs'),
    })
  } finally {
    await runtime.close()
  }
})

it('已开始的 IM 收件准备超时可重试，Core 仍能处理后续请求', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-worker-entry-'))
  directories.push(directory)
  const workerEntry = join(directory, 'worker.mjs')
  await writeFile(workerEntry, `
    import { parentPort } from 'node:worker_threads'
    parentPort.postMessage({ event: 'ready', ownerId: '00000000-0000-4000-8000-000000000001', schemaVersion: 'injected' })
    let prepares = 0
    parentPort.on('message', frame => {
      if (frame.method === 'im.inbox.prepare' && ++prepares === 1) {
        Atomics.store(new Int32Array(frame.cancel), 1, 1)
        return
      }
      parentPort.postMessage({ id: frame.id, result: null })
    })
  `)
  const runtime = await LocalRuntime.initialize(join(directory, 'unused.db'), { workerEntry })
  try {
    await expect(runtime.call('im.inbox.prepare', {}, { timeoutMs: 100 })).rejects.toMatchObject({ code: 'busy' })
    await expect(runtime.call('im.inbox.prepare')).resolves.toBeNull()
  } finally {
    await runtime.close()
  }
})
