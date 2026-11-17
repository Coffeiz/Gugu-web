import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Fastify from 'fastify'
import { registerAdminConfigRoutes } from '../../src/domains/admin/admin-config.js'

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
