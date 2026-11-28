import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Fastify from 'fastify'
import { registerAdminConfigRoutes } from '../../../src/modules/admin/config.js'
import { registerSandboxNetworkRoutes } from '../../../src/modules/admin/sandbox-network.js'

test('Admin 保存策略草稿，未装配宿主网络时实际执行保持断网', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-network-policy-'))
  const path = join(root, 'override.json')
  const app = Fastify()
  const url = '/api/v1/admin/sandbox/network'
  const headers = { authorization: 'synthetic-admin' }
  try {
    await writeFile(path, JSON.stringify({ sandbox: { network_profile: 'none' }, agent: { shell_enabled: true } }))
    const options: Parameters<typeof registerSandboxNetworkRoutes>[1] = { path, env: {}, async requireAdmin(request, reply) {
      if (request.headers.authorization !== headers.authorization) await reply.code(401).send()
    } }
    registerSandboxNetworkRoutes(app, options)
    registerAdminConfigRoutes(app, options)
    const configured = { mode: 'private', privateAccess: 'specified', rules: [
      { target: '10.20.30.0/24', protocol: 'tcp', ports: [443, 8443] },
    ] }
    assert.equal((await app.inject({ method: 'PATCH', url, payload: configured })).statusCode, 401)
    for (const target of ['0.0.0.0/0', '::/0', 'example.invalid', '10.20.30.0/33']) {
      assert.equal((await app.inject({ method: 'PATCH', url, headers, payload: {
        ...configured, rules: [{ ...configured.rules[0], target }],
      } })).statusCode, 422)
    }
    for (const value of [configured, { ...configured, privateAccess: 'all' }]) {
      const saved = await app.inject({ method: 'PATCH', url, headers, payload: value })
      assert.equal(saved.statusCode, 200)
      const current = await app.inject({ url, headers })
      assert.deepEqual(current.json(), { configured: value, effectiveMode: 'offline', ready: false })
    }
    const runtimeUrl = '/api/v1/admin/config'
    const quota = 128 * 1024 * 1024
    const patch = (sandbox: Record<string, unknown>) => app.inject({ method: 'PATCH', url: runtimeUrl, headers, payload: { patch: { sandbox } } })
    assert.equal((await patch({ ephemeral_quota_bytes: quota, direct_network_policy: { mode: 'invalid' } })).statusCode, 422)
    assert.equal(JSON.parse(await readFile(path, 'utf8')).sandbox.ephemeral_quota_bytes, undefined)
    assert.equal((await patch({ ephemeral_quota_bytes: quota, direct_network_policy: configured })).statusCode, 200)
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
      sandbox: { network_profile: 'none', direct_network_policy: configured, ephemeral_quota_bytes: quota },
      agent: { shell_enabled: true },
    })
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})
