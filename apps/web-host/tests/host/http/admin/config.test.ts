import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createApp } from '../../../../src/app.js'

test('生产 createApp 经 Admin guard 公布 schema 由部署迁移管理', async () => {
  const root = await mkdtemp(join(tmpdir(), 'admin-config-host-'))
  const path = join(root, 'override.json')
  await writeFile(path, JSON.stringify({ smtp: { host: 'mail.synthetic.invalid' } }))
  const app = createApp({
    appName: '合成应用', isReady: async () => true,
    adminAuth: {
      registerRoutes() {}, async verifyAdmin() { return true },
      async requireAdmin(request, reply) {
        if (request.headers.authorization !== 'test-admin') return reply.code(401).send({ detail: '管理员认证失败' })
      },
    },
    adminConfig: {
      path,
      env: { GUGU_WEBUI_DATABASE_URL: 'postgresql://synthetic:secret@db.synthetic.invalid/gugu' },
    },
  })
  try {
    assert.equal((await app.inject({ url: '/api/v1/admin/config' })).statusCode, 401)
    const response = await app.inject({ url: '/api/v1/admin/config', headers: { authorization: 'test-admin' } })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json().capabilities, { database_schema_managed_externally: true })
    assert.equal(response.json().data.db.password, '****')
    assert.equal(response.json().data.smtp.host, 'mail.synthetic.invalid')
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/admin/config/init-db', headers: { authorization: 'test-admin' } })).statusCode, 404)
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})
