import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { createApp } from '../../../src/app.js'
import { registerSandboxDisableRoute } from '../../../src/modules/admin/sandbox.js'
import { createSandboxRuntimeUpdater } from '../../../src/modules/admin/sandbox.js'

test('停用 MXC Shell 原子关闭后续权限且保留无关配置', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-sandbox-disable-'))
  const path = join(directory, 'config.override.json')
  await writeFile(path, JSON.stringify({ unrelated: { keep: true }, agent: { shell_enabled: true, shell_system_enabled: true, shell_dangerous_enabled: true }, sandbox: { enabled: true, network_profile: 'none' } }))
  const app = Fastify()
  let refreshes = 0
  registerSandboxDisableRoute(app, {
    async requireAdmin() {},
    async publishTerminalRefresh() { refreshes++ },
    updateDisabled: () => createSandboxRuntimeUpdater(path)(false),
    async readSettings() {
      const config = JSON.parse(await readFile(path, 'utf8'))
      return {
        shellEnabled: config.agent.shell_enabled, shellDangerousEnabled: config.agent.shell_dangerous_enabled,
        sandboxEnabled: config.sandbox.enabled, sandboxReady: true, filesystemAuthorizationEnabled: true,
        networkProfile: 'none',
      }
    },
    async readiness() { return { supported: true, methods: ['bubblewrap'], checkAvailable: true, proxyEnforcement: false } },
  })
  try {
    const response = await app.inject({ method: 'POST', url: '/api/v1/admin/sandbox/disable' })
    assert.equal(response.statusCode, 200)
    assert.equal(refreshes, 1)
    assert.equal(response.json().state, 'disabled')
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
      unrelated: { keep: true },
      agent: { shell_enabled: false, shell_system_enabled: false, shell_dangerous_enabled: false },
      sandbox: { enabled: false, network_profile: 'none' },
    })
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('生产 createApp 将停用路由置于真实 Admin guard 后', async () => {
  let authorized = false
  let writes = 0
  let refreshes = 0
  const app = createApp({
    appName: 'test', isReady: async () => true,
    adminAuth: {
      registerRoutes() {},
      async requireAdmin(_request, reply) { if (!authorized) return reply.code(401).send({ detail: 'unauthorized' }) },
      async verifyAdmin() { return authorized },
    },
    sandboxDisable: {
      async updateDisabled() { writes++ },
      async publishTerminalRefresh() { refreshes++ },
      async readSettings() {
        return { shellEnabled: false, shellDangerousEnabled: false, sandboxEnabled: false, sandboxReady: true,
          filesystemAuthorizationEnabled: true, networkProfile: 'none' }
      },
      async readiness() { return { supported: true, methods: ['bubblewrap'], checkAvailable: true, proxyEnforcement: false } },
    },
  })
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/admin/sandbox/disable' })).statusCode, 401)
    assert.equal(writes, 0)
    assert.equal(refreshes, 0)
    authorized = true
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/admin/sandbox/disable' })).statusCode, 200)
    assert.equal(writes, 1)
    assert.equal(refreshes, 1)
  } finally { await app.close() }
})
