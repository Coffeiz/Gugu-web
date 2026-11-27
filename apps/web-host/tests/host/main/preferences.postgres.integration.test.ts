import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { migratePostgres } from '@gugu/database/postgres'
import test from 'node:test'
import { createUserToken } from '../../../src/modules/auth/session/token.js'
import { startServer } from '../../../src/main.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
async function freePort(): Promise<number> {
  const socket = createServer()
  await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve) })
  const address = socket.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()))
  return address.port
}

test('生产 Host 使用 Core 偏好存储并隔离用户', { skip: !databaseUrl && '需要隔离 PostgreSQL' }, async () => {
  const schema = `prefs_main_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const scoped = new URL(databaseUrl!)
  scoped.searchParams.set('options', `-c search_path=${schema}`)
  const pool = new Pool({ connectionString: scoped.toString(), max: 2 })
  const root = await mkdtemp(join(tmpdir(), 'gugu-preferences-main-'))
  let host: Awaited<ReturnType<typeof startServer>> | undefined
  try {
    const config = join(root, 'config.json')
    await writeFile(config, '{}')
    assert.equal(await migratePostgres(pool, 'apply'), 'applied')
    const owner = randomUUID(), other = randomUUID(), secret = 'synthetic-preferences-main-secret'
    await pool.query(`INSERT INTO users(id,username,email,hashed_password,is_active,account_status,security_version,created_at,email_subscribed)
      VALUES ($1,'sample-owner','owner@example.test','synthetic',true,'active',1,CURRENT_TIMESTAMP,false),
             ($2,'sample-other','other@example.test','synthetic',true,'active',1,CURRENT_TIMESTAMP,false)`, [owner, other])
    host = await startServer({ GUGU_WEBUI_DATABASE_URL: scoped.toString(), GUGU_WEBUI_SECRET_KEY: secret,
      GUGU_CONFIG_OVERRIDE_FILE: config, STORAGE__LOCAL_PATH: join(root, 'storage'), GUGU_WEBUI_HOST: '127.0.0.1', GUGU_WEBUI_PORT: String(await freePort()), GUGU_WEBUI_REDIS_URL: '' })
    const headers = (id: string) => ({ authorization: `Bearer ${createUserToken(id, 1, secret)}` })
    const write = await host.app.inject({ method: 'PATCH', url: '/api/v1/preferences', headers: headers(owner), payload: { palette: 'green', theme: 'dark' } })
    assert.equal(write.statusCode, 200)
    const mine = await host.app.inject({ url: '/api/v1/preferences', headers: headers(owner) })
    assert.equal(mine.json().palette, 'green')
    assert.equal(mine.json().theme, 'dark')
    const theirs = await host.app.inject({ url: '/api/v1/preferences', headers: headers(other) })
    assert.equal(theirs.json().palette, 'neutral')
    assert.equal(theirs.json().theme, 'light')
    const rows = await pool.query('SELECT user_id,data_json FROM user_preferences')
    assert.equal(rows.rowCount, 1)
    assert.equal(rows.rows[0].user_id, owner)
    assert.deepEqual(JSON.parse(rows.rows[0].data_json), { palette: 'green', theme: 'dark' })
  } finally {
    await host?.close(); await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end()
    await rm(root, { recursive: true, force: true })
  }
})
