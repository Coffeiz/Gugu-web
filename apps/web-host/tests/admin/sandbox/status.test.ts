import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import { registerSandboxStatusRoute } from '../../../src/modules/admin/sandbox.js'
import { createApp } from '../../../src/app.js'

test('管理员沙盒状态反映 MXC、Shell 开关和 egress readiness，不暴露旧 Docker 字段', async () => {
  let authorized = false
  const app = Fastify()
  registerSandboxStatusRoute(app, {
    async requireAdmin(_request, reply) { if (!authorized) return reply.code(401).send({ detail: 'unauthorized' }) },
    async readSettings() {
      return {
        shellEnabled: true, shellDangerousEnabled: false, sandboxEnabled: true, sandboxReady: true,
        filesystemAuthorizationEnabled: true, networkProfile: 'egress',
        egressProxyUrl: 'http://127.0.0.1:8123',
      }
    },
    async readiness() { return { supported: true, methods: ['bubblewrap'], checkAvailable: true, proxyEnforcement: true } },
  })
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/admin/sandbox/status' })).statusCode, 401)
    authorized = true
    const response = await app.inject({ method: 'GET', url: '/api/v1/admin/sandbox/status' })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(JSON.parse(response.body), {
      enabled: true,
      sandbox_ready: true,
      shell_enabled: true,
      shell_dangerous_enabled: false,
      runtime_supported: true,
      runtime_methods: ['bubblewrap'],
      readiness_checked: true,
      state: 'ready',
      message: 'MXC Bubblewrap 执行环境已就绪',
      network_profile: 'egress',
      egress_proxy_configured: true,
      egress_proxy_url: 'http://127.0.0.1:8123',
      egress_network_ready: true,
      egress_config_error: null,
      egress_available: true,
      egress_enabled: true,
    })
    assert.equal('docker_installed' in response.json(), false)
  } finally { await app.close() }
})

test('egress 被选中但代理执行能力未就绪时，管理员看到不可用而不是绿色 ready', async () => {
  const app = Fastify()
  registerSandboxStatusRoute(app, {
    async requireAdmin() {},
    async readSettings() {
      return {
        shellEnabled: true, shellDangerousEnabled: true, sandboxEnabled: true, sandboxReady: false,
        sandboxReason: 'MXC 代理专用出站未就绪', filesystemAuthorizationEnabled: true,
        networkProfile: 'egress', egressProxyError: 'MXC 代理专用出站未就绪',
      }
    },
    async readiness() { return { supported: true, methods: ['bubblewrap'], checkAvailable: true, proxyEnforcement: false, proxyEnforcementReason: 'MXC 代理专用出站未就绪' } },
  })
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/admin/sandbox/status' })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.state, 'egress_unready')
    assert.equal(body.egress_enabled, false)
    assert.equal(body.egress_network_ready, false)
    assert.equal(body.egress_config_error, 'MXC 代理专用出站未就绪')
  } finally { await app.close() }
})

test('生产 createApp 将沙盒状态路由置于真实 Admin guard 后', async () => {
  let authorized = false
  const app = createApp({
    appName: 'test', isReady: async () => true,
    adminAuth: {
      registerRoutes() {},
      async requireAdmin(_request, reply) { if (!authorized) return reply.code(401).send({ detail: 'unauthorized' }) },
      async verifyAdmin() { return authorized },
    },
    sandboxStatus: {
      async readSettings() {
        return {
          shellEnabled: true, shellDangerousEnabled: true, sandboxEnabled: false, sandboxReady: false,
          sandboxReason: 'Shell 沙盒已关闭', filesystemAuthorizationEnabled: true, networkProfile: 'none',
        }
      },
      async readiness() { return { supported: true, methods: ['bubblewrap'], checkAvailable: true, proxyEnforcement: false } },
    },
  })
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/admin/sandbox/status' })).statusCode, 401)
    authorized = true
    const response = await app.inject({ method: 'GET', url: '/api/v1/admin/sandbox/status' })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().state, 'disabled')
  } finally { await app.close() }
})

test('直连 Bubblewrap 在就绪前后都报告实际后端，并关闭代理出站', async () => {
  const app = Fastify()
  let supported = false
  let networkProfile: 'none' | 'egress' = 'none'
  registerSandboxStatusRoute(app, {
    async requireAdmin() {},
    async readSettings() {
      return { shellEnabled: true, shellDangerousEnabled: false, sandboxEnabled: true,
        sandboxReady: supported && networkProfile === 'none', networkProfile }
    },
    async readiness() {
      return { executionBackend: 'bubblewrap', supported, methods: supported ? ['bubblewrap'] : [],
        checkAvailable: true, proxyEnforcement: false }
    },
  })
  try {
    const url = '/api/v1/admin/sandbox/status'
    const unready = (await app.inject(url)).json()
    assert.equal(unready.execution_backend, 'bubblewrap')
    assert.equal(unready.state, 'runtime_unavailable')
    supported = true
    const ready = (await app.inject(url)).json()
    assert.equal(ready.execution_backend, 'bubblewrap')
    assert.equal(ready.message, 'Bubblewrap 执行环境已就绪')
    assert.equal(ready.egress_available, false)
    networkProfile = 'egress'
    const legacyProfile = (await app.inject(url)).json()
    assert.equal(legacyProfile.state, 'egress_unready')
    assert.match(legacyProfile.egress_config_error, /仅支持断网/)
  } finally { await app.close() }
})
