import assert from 'node:assert/strict'
import Fastify from 'fastify'
import test from 'node:test'
import { createServiceRestarter, registerServiceRestartRoute, type ServiceRestartRuntime } from '../../src/modules/admin/service-restart.js'

function runtime(overrides: Partial<ServiceRestartRuntime> = {}) {
  const calls: string[] = []
  const base = {
    async readHeartbeat(name: string) {
      calls.push(`heartbeat:${name}`)
      return { pid: 4242, host: 'synthetic-host' }
    },
    hostName: () => 'synthetic-host',
    processCommandLine: (_pid: number) => '/venv/bin/python -m worker',
    signal(_pid: number, signal: string) { calls.push(`signal:${signal}`) },
    async waitForExit(_pid: number, timeoutMs: number) {
      calls.push(`wait:${timeoutMs}`)
      return true
    },
    async isSystemdManaged(_name: string) { return true },
    async respawn(name: string, oldPid: number) {
      calls.push(`respawn:${name}:${oldPid}`)
      return 9001
    },
  }
  return { calls, ports: { ...base, ...overrides } }
}

test('仅允许重启白名单中的 worker/gateway', async () => {
  const fake = runtime()
  const restart = createServiceRestarter(fake.ports)
  await assert.rejects(restart('web'), { code: 'unsupported_service' })
  assert.deepEqual(fake.calls, [])
})

test('远端心跳和命令行不匹配时跳过进程操作', async () => {
  const remote = runtime({ async readHeartbeat() { return { pid: 4242, host: 'other-host' } } })
  const remoteResult = await createServiceRestarter(remote.ports)('worker')
  assert.equal(remoteResult.ok, false)
  assert.deepEqual(remote.calls, ['heartbeat:worker'])

  const reusedPid = runtime({ processCommandLine: () => '/usr/bin/python -m unrelated' })
  const reusedResult = await createServiceRestarter(reusedPid.ports)('worker')
  assert.equal(reusedResult.ok, false)
  assert.deepEqual(reusedPid.calls, ['heartbeat:worker'])
})

test('systemd 管理的服务只发 SIGTERM 并交由 systemd 拉起', async () => {
  const fake = runtime()
  const result = await createServiceRestarter(fake.ports)('worker')
  assert.deepEqual(result, { ok: true, msg: '已停止 worker (pid 4242)，systemd 将自动拉起。' })
  assert.deepEqual(fake.calls, ['heartbeat:worker', 'signal:SIGTERM'])
})

test('非 systemd 服务等待旧进程退出后按白名单模块重新拉起', async () => {
  const fake = runtime({
    async isSystemdManaged() { return false },
    async waitForExit(_pid: number, timeoutMs: number) { fake.calls.push(`wait:${timeoutMs}`); return false },
  })
  const result = await createServiceRestarter(fake.ports)('gateway')
  assert.equal(result.ok, true)
  assert.equal(result.msg, '已重启 gateway：旧 pid 4242 → 新 pid 9001（后端自管理，非 systemd）。')
  assert.deepEqual(fake.calls, [
    'heartbeat:gateway', 'signal:SIGTERM', 'wait:8000', 'signal:SIGKILL', 'wait:3000', 'respawn:gateway:4242',
  ])
})

test('管理员守卫先于服务重启执行', async () => {
  const fake = runtime()
  const app = Fastify({ logger: false })
  registerServiceRestartRoute(app, {
    requireAdmin: async (_request, reply) => reply.code(401).send({ detail: '未认证' }),
    restart: createServiceRestarter(fake.ports),
  })
  try {
    const response = await app.inject({ method: 'POST', url: '/api/v1/admin/services/worker/restart' })
    assert.equal(response.statusCode, 401)
    assert.deepEqual(fake.calls, [])
  } finally {
    await app.close()
  }
})
