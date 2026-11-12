import { expect, it } from 'vitest'
import { MessageChannel } from 'node:worker_threads'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { LocalRuntime } from '../../../dist/runtime/local.js'
import { attachIpcTransport } from '../../../src/runtime/transport/ipc.js'

it('注入的真实 IPC 端口保留同样的身份、收据和命令契约，关闭释放 Worker', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gugu-ipc-port-')),
    runtime = await LocalRuntime.initialize(join(root, 'core.db'))
  const channel = new MessageChannel(),
    ready = once(channel.port2, 'message')
  const server = attachIpcTransport(runtime, channel.port1)
  const exchange = async (frame: unknown) => {
    const pending = once(channel.port2, 'message')
    channel.port2.postMessage(frame)
    return (await pending)[0]
  }
  try {
    expect((await ready)[0]).toMatchObject({
      v: 2,
      event: 'ready',
      schema: '3',
    })
    const operation = randomUUID(),
      create = {
        v: 2,
        id: 1,
        method: 'projects.create',
        params: { name: '端口计划' },
        operation_id: operation,
      }
    const first = await exchange(create)
    expect(await exchange({ ...create, id: 2 })).toMatchObject({
      id: 2,
      result: first.result,
    })
    expect(
      await exchange({
        v: 2,
        id: 3,
        method: 'projects.list',
        params: { owner_id: randomUUID() },
      }),
    ).toMatchObject({ error: { code: 'invalid_request' } })
    expect(await exchange({ v: 2, id: 4, method: 'shell.run', params: {} })).toMatchObject({
      error: { code: 'invalid_request' },
    })
    expect(
      await exchange({ v: 2, id: 5, method: 'projects.list', params: {} }),
    ).toMatchObject({ result: [{ name: '端口计划' }] })
    expect(
      await exchange({
        v: 2,
        id: 6,
        method: 'operations.get',
        params: { operation_id: operation },
      }),
    ).toMatchObject({
      result: { method: 'projects.create', result: first.result },
    })
    await Promise.all([server.close(), server.close()])
    await expect(runtime.call('projects.list')).rejects.toMatchObject({
      code: 'closed',
    })
  } finally {
    await server.close()
    channel.port1.close()
    channel.port2.close()
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    })
  }
})
