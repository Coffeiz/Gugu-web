import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import test from 'node:test'
import { startServer } from '../../src/main.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const redisUrl = process.env.GUGU_WEBUI_TEST_REDIS_URL
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

test('生产 Host 使用共享 Redis 撤销版本并在 Redis 故障时拒绝认证', {
  skip: (!databaseUrl || !redisUrl) && '需要隔离 PostgreSQL 和 Redis',
}, async () => {
  const schema = `admin_auth_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const scoped = new URL(databaseUrl!)
  scoped.searchParams.set('options', `-c search_path=${schema}`)
  const pool = new Pool({ connectionString: scoped.toString(), max: 1 })
  const root = await mkdtemp(join(tmpdir(), 'gugu-admin-main-'))
  const overridePath = join(root, 'config.json')
  const hosts: Array<Awaited<ReturnType<typeof startServer>>> = []
  try {
    await writeFile(overridePath, '{}')
    await pool.query('CREATE TABLE audit_logs(id serial PRIMARY KEY,username text NOT NULL,action text NOT NULL,description text NOT NULL,ip text,created_at timestamptz NOT NULL)')
    const env = { GUGU_WEBUI_DATABASE_URL: scoped.toString(), GUGU_WEBUI_SECRET_KEY: 'synthetic-admin-main-secret',
      GUGU_CONFIG_OVERRIDE_FILE: overridePath, GUGU_WEBUI_HOST: '127.0.0.1', GUGU_WEBUI_REDIS_URL: redisUrl!,
      ADMIN_USERNAME: 'synthetic-admin', ADMIN_PASSWORD: 'synthetic-password' }
    for (let i = 0; i < 2; i++) hosts.push(await startServer({ ...env, GUGU_WEBUI_PORT: String(await freePort()) }))
    const limitHeaders = { 'x-forwarded-for': '203.0.113.18' }
    for (let attempt = 0; attempt < 10; attempt++) {
      const rejected = await hosts[attempt % 2]!.app.inject({ method: 'POST', url: '/api/v1/admin/auth/login',
        headers: limitHeaders, payload: { username: 'synthetic-admin', password: 'incorrect-password' } })
      assert.equal(rejected.statusCode, 401)
    }
    const limited = await hosts[0]!.app.inject({ method: 'POST', url: '/api/v1/admin/auth/login',
      headers: limitHeaders, payload: { username: 'synthetic-admin', password: 'synthetic-password' } })
    assert.equal(limited.statusCode, 429)
    const login = await hosts[0]!.app.inject({ method: 'POST', url: '/api/v1/admin/auth/login',
      payload: { username: 'synthetic-admin', password: 'synthetic-password' } })
    assert.equal(login.statusCode, 200)
    const headers = { authorization: `Bearer ${login.json().access_token}` }
    assert.equal((await hosts[1]!.app.inject({ url: '/api/v1/admin/auth/me', headers })).statusCode, 200)
    assert.equal((await hosts[1]!.app.inject({ method: 'POST', url: '/api/v1/admin/auth/logout', headers })).statusCode, 200)
    assert.equal((await hosts[0]!.app.inject({ url: '/api/v1/admin/auth/me', headers })).statusCode, 401)
    const unavailable = await startServer({ ...env, GUGU_WEBUI_REDIS_URL: 'redis://127.0.0.1:1', GUGU_WEBUI_PORT: String(await freePort()) })
    hosts.push(unavailable)
    assert.equal((await unavailable.app.inject({ method: 'POST', url: '/api/v1/admin/auth/login',
      payload: { username: 'synthetic-admin', password: 'synthetic-password' } })).statusCode, 503)
    const single = await startServer({ ...env, GUGU_WEBUI_REDIS_URL: '', GUGU_WEBUI_PORT: String(await freePort()) })
    hosts.push(single)
    assert.equal((await single.app.inject({ method: 'POST', url: '/api/v1/admin/auth/login',
      payload: { username: 'synthetic-admin', password: 'synthetic-password' } })).statusCode, 200)
  } finally {
    await Promise.all(hosts.map((host) => host.close()))
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
    await rm(root, { recursive: true, force: true })
  }
})
