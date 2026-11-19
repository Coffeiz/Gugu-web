import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { registerSandboxEnableRoute, createSandboxRuntimeUpdater } from '../../src/modules/admin/sandbox.js'
import { createApp } from '../../src/app.js'

const settings = {
  shellEnabled: true, shellDangerousEnabled: false, sandboxEnabled: false, sandboxReady: true,
  filesystemAuthorizationEnabled: true, networkProfile: 'none' as const,
}

test('启用前要求 MXC 沙盒确实可执行，并原子更新只读配置目标字段', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-sandbox-enable-'))
  const path = join(directory, 'config.override.json')
  await writeFile(path, JSON.stringify({ agent: { shell_dangerous_enabled: false }, sandbox: { network_profile: 'none', enabled: false } }))
  const app = Fastify()
  let refreshes = 0
  registerSandboxEnableRoute(app, {
    async requireAdmin() {},
    updateEnabled: createSandboxRuntimeUpdater(path),
    async publishTerminalRefresh() { refreshes++ },
    async readSettings() { return { ...settings, sandboxEnabled: JSON.parse(await readFile(path, 'utf8')).sandbox.enabled } },
    async readiness() { return { supported: true, methods: ['bubblewrap'], checkAvailable: true, proxyEnforcement: false } },
  })
  try {
    const response = await app.inject({ method: 'POST', url: '/api/v1/admin/sandbox/enable' })
    assert.equal(response.statusCode, 200)
    assert.equal(refreshes, 1)
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
      agent: { shell_dangerous_enabled: false }, sandbox: { network_profile: 'none', enabled: true },
    })
    assert.equal(response.json().enabled, true)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('MXC 不支持或受控 egress 未就绪时拒绝启用且不写配置', async () => {
  for (const [settingsReady, runtime, expectedMessage] of [
    [{ ...settings, sandboxReady: false, sandboxReason: 'MXC 不可用' }, { supported: false, methods: [], checkAvailable: true }, 'MXC 不可用'],
    [{ ...settings, sandboxReady: false, networkProfile: 'egress' as const, sandboxReason: '代理未就绪' }, { supported: true, methods: ['bubblewrap'], checkAvailable: true, proxyEnforcement: false }, '代理未就绪'],
  ] as const) {
    let writes = 0
    const app = Fastify()
    registerSandboxEnableRoute(app, {
      async requireAdmin() {},
      async publishTerminalRefresh() { assert.fail('失败的 enable 不应广播刷新') },
      async updateEnabled() { writes += 1 },
      async readSettings() { return settingsReady },
      async readiness() { return runtime },
    })
    try {
      const response = await app.inject({ method: 'POST', url: '/api/v1/admin/sandbox/enable' })
      assert.equal(response.statusCode, 409)
      assert.deepEqual(response.json(), { detail: expectedMessage })
      assert.equal(writes, 0)
    } finally { await app.close() }
  }
})

test('生产 createApp 将启用路由置于真实 Admin guard 后', async () => {
  let authorized = false
  const app = createApp({
    appName: 'test', isReady: async () => true,
    adminAuth: {
      registerRoutes() {},
      async requireAdmin(_request, reply) { if (!authorized) return reply.code(401).send({ detail: 'unauthorized' }) },
      async verifyAdmin() { return authorized },
    },
    sandboxEnable: {
      async updateEnabled() {},
      async publishTerminalRefresh() {},
      async readSettings() { return settings },
      async readiness() { return { supported: true, methods: ['bubblewrap'], checkAvailable: true, proxyEnforcement: false } },
    },
  })
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/admin/sandbox/enable' })).statusCode, 401)
    authorized = true
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/admin/sandbox/enable' })).statusCode, 200)
  } finally { await app.close() }
})
