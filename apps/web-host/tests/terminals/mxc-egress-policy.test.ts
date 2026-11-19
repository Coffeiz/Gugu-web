import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { MxcExecutor } from '@gugu/sandbox/mxc'
import { executionPolicy } from '../../../../packages/sandbox/src/policy.js'

test('MXC 代理模式保持默认拒绝并只声明经验证的回环代理', async () => {
  const request = { id: '00000000-0000-4000-8000-000000000001', command: 'curl https://example.invalid', cwd: '/synthetic/workspace', timeoutMs: 1000, destructive: false }
  const grant = { requestId: request.id, command: request.command, cwd: request.cwd, backend: 'mxc', confirmed: false,
    readonlyPaths: [request.cwd], readwritePaths: [], environment: {}, timeoutMs: 1000, maxOutputBytes: 1024 }
  let captured: unknown
  const spawn = async (value: { network: unknown }) => { captured = value.network; return { standardOutput: new PassThrough(), standardError: new PassThrough(), kill() {}, dispose() {},
    async wait() { return { exitCode: 0, timedOut: false } } } }
  const executor = new MxcExecutor(spawn, 'bubblewrap', 'http://127.0.0.1:3128')
  await executor.execute(executionPolicy(request, grant, { filesystem: true, networkDeny: true, uiDeny: true, timeout: true, cancellation: true }))
  assert.deepEqual(captured, { egress: { default: 'deny' }, ingress: { default: 'deny', hostLoopback: 'deny' }, runtimeConfig: { networkProxy: 'http://127.0.0.1:3128' } })
  assert.throws(() => new MxcExecutor(spawn, 'bubblewrap', 'http://proxy.example:3128'), /本机回环/)
  assert.throws(() => new MxcExecutor(spawn, 'bubblewrap', 'http://user:secret@127.0.0.1:3128'), /本机回环/)
})
