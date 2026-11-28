import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { createMxcPtyBridge, type MxcPtyProcessLike } from '@gugu/sandbox/pty'

test('MXC PTY bridge applies an isolated request and forwards terminal controls', async () => {
  const output = new PassThrough()
  const input = new PassThrough()
  const written: Buffer[] = []
  input.on('data', chunk => written.push(Buffer.from(chunk)))
  const resized: Array<{ rows: number; columns: number }> = []
  let killed = 0
  let disposed = 0
  let released = 0
  const process: MxcPtyProcessLike = {
    id: 321,
    input,
    output,
    resize(size) { resized.push(size) },
    kill() { killed += 1 },
    wait: async () => ({ exitCode: 137, timedOut: false }),
    dispose() { disposed += 1 },
  }
  const requests: unknown[] = []
  const bridge = createMxcPtyBridge({
    command: '/bin/bash --login',
    spawn: async (request, options) => {
      requests.push({ request, options })
      return process
    },
  })

  const handle = await bridge.open({
    terminalId: 'term-1',
    root: '/srv/synthetic/user',
    readwritePaths: ['/srv/synthetic/user', '/srv/synthetic/workspace'],
    readonlyPaths: ['/srv/synthetic/project'],
    environment: { HOME: '/srv/synthetic/user', PATH: '/usr/bin:/bin' },
    networkProfile: 'none',
    cols: 100,
    rows: 30,
    release: async () => { released += 1 },
  })

  assert.equal(handle.pid, 321)
  assert.equal(handle.sandboxId, 'term-1:321')
  assert.deepEqual(requests, [{
    request: {
      command: '/bin/bash --login',
      containment: { type: 'bubblewrap' },
      workingDirectory: '/srv/synthetic/user',
      filesystem: { readwritePaths: ['/srv/synthetic/user', '/srv/synthetic/workspace'], readonlyPaths: ['/srv/synthetic/project'] },
      network: { egress: { default: 'deny' }, ingress: { default: 'deny', hostLoopback: 'deny' } },
      ui: { disable: true, clipboard: 'none', allowInputInjection: false },
      environment: { HOME: '/srv/synthetic/user', PATH: '/usr/bin:/bin' },
      inheritDefaultEnvironment: false,
    },
    options: { size: { columns: 100, rows: 30 } },
  }])

  await handle.write(Buffer.from('echo safe\n'))
  await handle.resize(120, 40)
  await handle.signal('SIGINT')
  assert.deepEqual(Buffer.concat(written).toString(), 'echo safe\n\u0003')
  assert.deepEqual(resized, [{ columns: 120, rows: 40 }])

  output.end(Buffer.from('hello'))
  const chunks: Buffer[] = []
  for await (const chunk of handle.output()) chunks.push(Buffer.from(chunk))
  assert.equal(Buffer.concat(chunks).toString(), 'hello')

  await handle.close()
  assert.equal(killed, 1)
  assert.equal(disposed, 1)
  assert.equal(released, 1)
})

test('MXC PTY bridge only permits the configured egress proxy for egress terminals', async () => {
  const output = new PassThrough()
  const process = {
    id: 1, input: new PassThrough(), output,
    resize() {}, kill() {},
    wait: async () => ({ exitCode: 137, timedOut: false }),
    dispose() {},
  } satisfies MxcPtyProcessLike
  let network: unknown
  const bridge = createMxcPtyBridge({
    command: '/bin/bash',
    spawn: async request => { network = request.network; return process },
  })
  const handle = await bridge.open({
    terminalId: 'term-2', root: '/srv/synthetic/user', readwritePaths: ['/srv/synthetic/user'],
    readonlyPaths: [], networkProfile: 'egress', cols: 120, rows: 32,
    environment: { HOME: '/srv/synthetic/user', PATH: '/usr/bin:/bin' },
    egressProxyUrl: 'http://127.0.0.1:4321',
  })
  assert.deepEqual(network, {
    egress: { default: 'deny' },
    ingress: { default: 'deny', hostLoopback: 'deny' },
    runtimeConfig: { networkProxy: 'http://127.0.0.1:4321' },
  })
  await handle.close()
})

test('MXC PTY bridge fails closed for egress without a proxy and for a root outside granted paths', async () => {
  let calls = 0
  const bridge = createMxcPtyBridge({
    command: '/bin/bash',
    spawn: async () => {
      calls += 1
      throw new Error('unexpected spawn')
    },
  })
  const base = {
    terminalId: 'term-3', root: '/srv/synthetic/user', readwritePaths: ['/srv/synthetic/user'],
    readonlyPaths: [], cols: 120, rows: 32,
    environment: { PATH: '/usr/bin:/bin' },
  }
  await assert.rejects(
    bridge.open({ ...base, networkProfile: 'egress' }),
    /代理不可用/,
  )
  await assert.rejects(
    bridge.open({ ...base, root: '/srv/synthetic/other', networkProfile: 'none' }),
    /授权范围/,
  )
  assert.equal(calls, 0)
})
