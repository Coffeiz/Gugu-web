import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { createTerminalPtyManager } from '../../src/modules/terminals/pty/manager.js'
import type { MxcPtyBridge, MxcPtyHandle, MxcPtyLaunchSpec } from '@gugu/sandbox/pty'

function fixture() {
  const streams = new Map<string, PassThrough>()
  const closed: string[] = []
  const writes: Buffer[] = []
  const bridge: MxcPtyBridge = {
    async open(spec: MxcPtyLaunchSpec): Promise<MxcPtyHandle> {
      const output = new PassThrough()
      streams.set(spec.terminalId, output)
      return {
        pid: 77,
        sandboxId: `${spec.terminalId}:77`,
        async write(data) { writes.push(Buffer.from(data)) },
        async resize() {},
        async signal() {},
        async close() { closed.push(spec.terminalId); output.end() },
        async *output() { for await (const chunk of output) yield Buffer.from(chunk) },
      }
    },
  }
  return { manager: createTerminalPtyManager({ bridge, detachedTtlMs: 100, now: () => 1000 }), streams, closed, writes }
}

const spec: MxcPtyLaunchSpec = {
  terminalId: 'term-1', root: '/srv/synthetic/user', readwritePaths: ['/srv/synthetic/user'],
  readonlyPaths: [], networkProfile: 'none', cols: 120, rows: 32,
  environment: { PATH: '/usr/bin:/bin' },
}

test('terminal PTY manager subscribes before forwarding output and ends detached readers on exit', async () => {
  const { manager, streams, closed } = fixture()
  const { queue } = await manager.startWithSubscription(spec)
  await manager.attach(spec.terminalId)
  streams.get(spec.terminalId)!.write(Buffer.from('prompt'))
  assert.equal(Buffer.from(await queue.take()!).toString(), 'prompt')
  streams.get(spec.terminalId)!.end()
  assert.equal(await queue.take(), null)
  assert.equal(manager.get(spec.terminalId), undefined)
  assert.deepEqual(closed, ['term-1'])
})

test('terminal PTY manager caps active sessions and reaps detached PTYs after the TTL', async () => {
  const { manager, closed } = fixture()
  await manager.start(spec)
  await manager.attach(spec.terminalId)
  await manager.attach(spec.terminalId)
  await assert.rejects(manager.attach(spec.terminalId), /连接数已达上限/)
  await manager.detach(spec.terminalId)
  await manager.detach(spec.terminalId)
  assert.deepEqual(await manager.reapDetached(1099), [])
  assert.deepEqual(await manager.reapDetached(1100), ['term-1'])
  assert.deepEqual(closed, ['term-1'])
})

test('terminal PTY manager rejects writes when no WebSocket is attached', async () => {
  const { manager, writes } = fixture()
  await manager.start(spec)
  await assert.rejects(manager.write(spec.terminalId, Buffer.from('echo no')), /没有活动连接/)
  assert.deepEqual(writes, [])
  await manager.closeAll()
})

test('detaching a closed WebSocket wakes its output reader and releases queued chunks', async () => {
  const state = fixture()
  const started = await state.manager.startWithSubscription(spec)
  await state.manager.attach(spec.terminalId)
  const pending = started.queue.take()
  await state.manager.unsubscribe(spec.terminalId, started.queue)
  assert.equal(await pending, null)
  await state.manager.detach(spec.terminalId)
  assert.equal(state.manager.get(spec.terminalId)?.attached, 0)
  await state.manager.closeAll()
})

test('MXC 关闭失败时保留 PTY 句柄以便安全重试', async () => {
  const output = new PassThrough()
  let failClose = true
  const bridge: MxcPtyBridge = {
    async open(spec: MxcPtyLaunchSpec): Promise<MxcPtyHandle> {
      return {
        pid: 78, sandboxId: `${spec.terminalId}:78`, async write() {}, async resize() {}, async signal() {},
        async close() {
          if (failClose) { failClose = false; throw new Error('synthetic close failure') }
          output.end()
        },
        async *output() { for await (const chunk of output) yield Buffer.from(chunk) },
      }
    },
  }
  const manager = createTerminalPtyManager({ bridge })
  await manager.start(spec)
  await assert.rejects(manager.terminate(spec.terminalId), /synthetic close failure/)
  assert.ok(manager.get(spec.terminalId))
  await manager.terminate(spec.terminalId)
  assert.equal(manager.get(spec.terminalId), undefined)
})
