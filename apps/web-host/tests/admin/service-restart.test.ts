import assert from 'node:assert/strict'
import Fastify from 'fastify'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { createServiceRestarter, registerServiceRestartRoute } from '../../src/modules/admin/runtime.js'

import { createBackgroundWorkerLifecycle } from '../../src/maintenance/background-workers.js'

test('只重启 Node 后台任务，缺少 Node 网关能力时明确不可用', async () => {
  let calls = 0
  const restart = createServiceRestarter(async () => { calls++; return true })
  await assert.rejects(restart('web'), { code: 'unsupported_service' })
  assert.equal((await restart('gateway')).ok, false)
  assert.equal(calls, 0)
  assert.equal((await restart('worker')).ok, true)
  assert.equal(calls, 1)
})

test('重启等待旧实例退出并合并并发请求，关闭期间不再启动', async () => {
  const events: string[] = []
  let generation = 0
  let release!: () => void
  let entered!: () => void
  const draining = new Promise<void>(resolve => { entered = resolve })
  const stopGate = new Promise<void>(resolve => { release = resolve })
  const lifecycle = createBackgroundWorkerLifecycle([() => {
    const instance = ++generation
    events.push(`start:${instance}`)
    return { async stop() {
      events.push(`stop:${instance}`)
      if (instance === 1) { entered(); await stopGate }
    } }
  }])
  assert.equal(await lifecycle.restart(), false)
  await lifecycle.start()
  assert.deepEqual(lifecycle.status(), { online: true, restartable: true })
  const restart = lifecycle.restart()
  const concurrent = lifecycle.restart()
  assert.equal(restart, concurrent)
  await draining
  assert.deepEqual(events, ['start:1', 'stop:1'])
  release()
  assert.deepEqual(await Promise.all([restart, concurrent]), [true, true])
  const interrupted = lifecycle.restart()
  const closed = lifecycle.stop()
  assert.equal(await interrupted, false)
  await closed
  assert.deepEqual(events, ['start:1', 'stop:1', 'start:2', 'stop:2'])
  assert.deepEqual(lifecycle.status(), { online: false, restartable: false })
})

test('旧实例停止失败时禁止启动新实例，返回脱敏信息', async () => {
  let started = 0, fail = true
  const lifecycle = createBackgroundWorkerLifecycle([() => {
    started++
    return { async stop() { if (fail) throw new Error('synthetic private failure') } }
  }])
  await lifecycle.start()
  const result = await createServiceRestarter(lifecycle.restart)('worker')
  assert.deepEqual(result, { ok: false, msg: 'Node 后台任务重启失败。' })
  assert.equal(started, 1)
  fail = false
  await lifecycle.stop()
})

test('管理员守卫先于服务重启执行', async () => {
  let calls = 0
  const app = Fastify({ logger: false })
  registerServiceRestartRoute(app, {
    requireAdmin: async (_request, reply) => reply.code(401).send({ detail: '未认证' }),
    restart: createServiceRestarter(async () => { calls++; return true }),
  })
  try {
    const response = await app.inject({ method: 'POST', url: '/api/v1/admin/services/worker/restart' })
    assert.equal(response.statusCode, 401)
    assert.equal(calls, 0)
  } finally {
    await app.close()
  }
})

test('createApp 将服务重启路由接入管理员保护域', async () => {
  const calls: string[] = []
  const app = createApp({
    appName: '合成测试应用',
    async isReady() { return true },
    adminAuth: {
      registerRoutes() {},
      async requireAdmin() {},
      async verifyAdmin() { return true },
    },
    serviceRestart: {
      async restart(name) { calls.push(name); return { ok: true, msg: `已请求重启 ${name}` } },
    },
  })
  try {
    const response = await app.inject({ method: 'POST', url: '/api/v1/admin/services/worker/restart' })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { ok: true, msg: '已请求重启 worker' })
    assert.deepEqual(calls, ['worker'])
  } finally {
    await app.close()
  }
})
