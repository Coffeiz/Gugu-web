import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import test from 'node:test'
import Fastify from 'fastify'
import { registerAdminConfigRoutes } from '../../src/modules/admin/config.js'

test('Node Admin 配置说明数据库 schema 由部署迁移管理，保留 Python 配置字段契约', async () => {
  const root = await mkdtemp(join(tmpdir(), 'admin-config-capability-'))
  const path = join(root, 'override.json')
  await writeFile(path, JSON.stringify({ smtp: { host: 'mail.synthetic.invalid' } }))
  const app = Fastify()
  registerAdminConfigRoutes(app, { path, env: { GUGU_WEBUI_DATABASE_URL: 'postgresql://synthetic:secret@db.synthetic.invalid/gugu' }, requireAdmin: async () => {} })
  try {
    const response = await app.inject({ url: '/api/v1/admin/config' })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.deepEqual(body.capabilities, { database_schema_managed_externally: true })
    assert.equal(body.data.smtp.host, 'mail.synthetic.invalid')
    assert.equal(body.data.db.password, '****')
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('Node 2.0 Admin 连接测试拒绝已退役的 OSS 类型且不回显提交字段', async () => {
  const root = await mkdtemp(join(tmpdir(), 'admin-config-connection-'))
  const path = join(root, 'override.json')
  await writeFile(path, '{}')
  const app = Fastify()
  registerAdminConfigRoutes(app, { path, env: {}, requireAdmin: async () => {} })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/config/test-connection',
      payload: {
        type: 'oss',
        oss: { endpoint: 'storage.synthetic.invalid', access_key_secret: 'synthetic-secret' },
      },
    })
    assert.equal(response.statusCode, 400)
    assert.deepEqual(response.json(), {
      ok: false,
      message: 'Node 2.0 仅支持测试 PostgreSQL 和 Redis 连接',
    })
    assert.equal(response.body.includes('synthetic-secret'), false)
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('Node Redis 连通测试保留 Python 的 PONG 成功提示', async () => {
  const root = await mkdtemp(join(tmpdir(), 'admin-config-redis-'))
  const path = join(root, 'override.json')
  await writeFile(path, '{}')
  const commands: string[] = []
  const redis = createServer((socket) => {
    socket.on('data', (data) => {
      commands.push(data.toString())
      socket.write('+PONG\r\n')
    })
  })
  await new Promise<void>((resolve) => redis.listen(0, '127.0.0.1', resolve))
  const address = redis.address()
  assert.ok(address && typeof address !== 'string')
  const app = Fastify()
  registerAdminConfigRoutes(app, { path, env: {}, requireAdmin: async () => {} })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/config/test-connection',
      payload: { type: 'redis', redis: { host: '127.0.0.1', port: address.port } },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { ok: true, message: 'PONG — 连接正常' })
    assert.match(commands[0] ?? '', /PING/)
  } finally {
    await app.close()
    await new Promise<void>((resolve, reject) => redis.close((error) => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
