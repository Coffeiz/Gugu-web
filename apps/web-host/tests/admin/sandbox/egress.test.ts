import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { registerSandboxEgressRoutes, createSandboxEgressConfigUpdater } from '../../../src/modules/admin/sandbox.js'
import { createApp } from '../../../src/app.js'

test('管理员回环代理保存保留其他配置，清空时关闭 egress 网络配置', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-sandbox-egress-'))
  const path = join(directory, 'config.override.json')
  await writeFile(path, JSON.stringify({ unrelated: { keep: true }, sandbox: { network_profile: 'egress', enabled: true } }))
  const app = Fastify()
  try {
    registerSandboxEgressRoutes(app, {
      async requireAdmin(request, reply) { if (request.headers.authorization !== 'admin') await reply.code(401).send({ detail: 'unauthorized' }) },
      updateProxy: createSandboxEgressConfigUpdater(path),
      async readSettings() { return { networkProfile: 'none', egressProxyUrl: undefined, egressProxyError: undefined } },
      async readiness() { return { supported: true, proxyEnforcement: true } },
    })
    const denied = await app.inject({ method: 'POST', url: '/api/v1/admin/sandbox/egress/config', payload: { proxy_url: 'http://127.0.0.1:8123' } })
    assert.equal(denied.statusCode, 401)
    const invalid = await app.inject({ method: 'POST', url: '/api/v1/admin/sandbox/egress/config', headers: { authorization: 'admin' }, payload: { proxy_url: 'http://user:secret@127.0.0.1:8123' } })
    assert.equal(invalid.statusCode, 422)
    const saved = await app.inject({ method: 'POST', url: '/api/v1/admin/sandbox/egress/config', headers: { authorization: 'admin' }, payload: { proxy_url: 'http://127.0.0.1:8123' } })
    assert.equal(saved.statusCode, 200)
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { unrelated: { keep: true }, sandbox: { network_profile: 'egress', enabled: true, egress_proxy_url: 'http://127.0.0.1:8123' } })
    const cleared = await app.inject({ method: 'POST', url: '/api/v1/admin/sandbox/egress/config', headers: { authorization: 'admin' }, payload: { proxy_url: '' } })
    assert.equal(cleared.statusCode, 200)
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { unrelated: { keep: true }, sandbox: { network_profile: 'none', enabled: true, egress_proxy_url: '' } })
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('egress 校验只报告配置与 MXC proxy enforcement，不做外网探测', async () => {
  const app = Fastify()
  let proxyEnforcement = false
  try {
    registerSandboxEgressRoutes(app, {
      async requireAdmin() {},
      async updateProxy() {},
      async readSettings() { return { networkProfile: 'egress', egressProxyUrl: 'http://localhost:9000', egressProxyError: undefined } },
      async readiness() { return { supported: true, proxyEnforcement, proxyEnforcementReason: 'MXC 无代理隔离能力' } },
    })
    const unavailable = await app.inject({ method: 'POST', url: '/api/v1/admin/sandbox/egress/validate' })
    assert.equal(unavailable.statusCode, 409)
    proxyEnforcement = true
    const valid = await app.inject({ method: 'POST', url: '/api/v1/admin/sandbox/egress/validate' })
    assert.equal(valid.statusCode, 200)
    assert.deepEqual(valid.json(), { ok: true, message: '配置有效；MXC 将保持默认拒绝出站并只使用已配置的本机代理。实际代理连通性在命令执行时验证。', network_name: 'mxc-bubblewrap', proxy_configured: true })
  } finally { await app.close() }
})

test('createApp 的生产路由组合使用 Admin guard 并调用原子代理配置端口', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-sandbox-egress-host-'))
  const path = join(directory, 'config.override.json')
  await writeFile(path, JSON.stringify({ unrelated: { keep: true } }))
  let authorized = false
  const app = createApp({
    appName: 'test', isReady: async () => true,
    adminAuth: {
      registerRoutes() {},
      async requireAdmin(_request, reply) { if (!authorized) return reply.code(401).send({ detail: 'unauthorized' }) },
      async verifyAdmin() { return authorized },
    },
    sandboxEgress: {
      updateProxy: createSandboxEgressConfigUpdater(path),
      async readSettings() { return { networkProfile: 'egress', egressProxyUrl: 'http://127.0.0.1:8123' } },
      async readiness() { return { supported: true, proxyEnforcement: true } },
    },
  })
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/admin/sandbox/egress/config', payload: { proxy_url: 'http://127.0.0.1:8123' } })).statusCode, 401)
    authorized = true
    const response = await app.inject({ method: 'POST', url: '/api/v1/admin/sandbox/egress/config', payload: { proxy_url: 'http://127.0.0.1:8123' } })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
      unrelated: { keep: true }, sandbox: { egress_proxy_url: 'http://127.0.0.1:8123' },
    })
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})
