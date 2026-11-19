import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import test from 'node:test'
import { createUserToken } from '../../src/modules/auth/session/token.js'
import { startServer } from '../../src/main.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
async function freePort(): Promise<number> {
  const socket = createServer()
  await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve) })
  const address = socket.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()))
  return address.port
}

test('生产 Host 经认证调用 Core 引导仓储并隔离 PostgreSQL 用户', {
  skip: !databaseUrl && '需要隔离 PostgreSQL',
}, async () => {
  const schema = `onboarding_main_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const scoped = new URL(databaseUrl!)
  scoped.searchParams.set('options', `-c search_path=${schema}`)
  const pool = new Pool({ connectionString: scoped.toString(), max: 2 })
  const root = await mkdtemp(join(tmpdir(), 'gugu-onboarding-main-'))
  const overridePath = join(root, 'config.json')
  let host: Awaited<ReturnType<typeof startServer>> | undefined
  try {
    await writeFile(overridePath, '{}')
    await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY, username text NOT NULL, display_name text, email text NOT NULL,
      is_active boolean NOT NULL, account_status text, security_version integer, avatar text, created_at timestamptz,
      timezone text, email_subscribed boolean, last_active_at timestamptz);
      CREATE TABLE user_bots(user_id uuid NOT NULL,platform text NOT NULL,enabled boolean NOT NULL);
      CREATE TABLE onboarding_state(user_id uuid PRIMARY KEY REFERENCES users(id),state json,created_at timestamptz,updated_at timestamptz)`)
    const owner = randomUUID(), other = randomUUID(), secret = 'synthetic-onboarding-main-secret'
    await pool.query(`INSERT INTO users(id,username,email,is_active,account_status,security_version,created_at,email_subscribed)
      VALUES ($1,'synthetic-owner','owner@example.test',true,'active',1,CURRENT_TIMESTAMP,false),
             ($2,'synthetic-other','other@example.test',true,'active',1,CURRENT_TIMESTAMP,false)`, [owner, other])
    await pool.query('INSERT INTO onboarding_state(user_id,state) VALUES ($1,$2::json)',
      [owner, JSON.stringify({ seeded: true, seeded_project_id: 41, seeded_project_name: '合成项目' })])
    host = await startServer({ GUGU_WEBUI_DATABASE_URL: scoped.toString(), GUGU_WEBUI_SECRET_KEY: secret,
      GUGU_CONFIG_OVERRIDE_FILE: overridePath, GUGU_WEBUI_HOST: '127.0.0.1', GUGU_WEBUI_PORT: String(await freePort()),
      GUGU_WEBUI_REDIS_URL: '' })
    const headers = (userId: string) => ({ authorization: `Bearer ${createUserToken(userId, 1, secret)}` })
    assert.equal((await host.app.inject({ url: '/api/v1/onboarding/state' })).statusCode, 401)
    const initial = await host.app.inject({ url: '/api/v1/onboarding/state', headers: headers(owner) })
    assert.equal(initial.statusCode, 200)
    assert.deepEqual(initial.json().seed, { seeded: true, project_id: 41, project_name: '合成项目' })
    const patch = await host.app.inject({ method: 'PATCH', url: '/api/v1/onboarding/state', headers: headers(owner),
      payload: { current_step: 'model', completed_steps: ['locale'], dismissed: true } })
    assert.equal(patch.statusCode, 200)
    assert.equal(patch.json().guide.current_step, 'model')
    const reopened = await host.app.inject({ method: 'POST', url: '/api/v1/onboarding/state/reopen', headers: headers(owner) })
    assert.equal(reopened.statusCode, 200)
    assert.deepEqual(reopened.json().guide.completed_steps, ['locale'])
    assert.equal(reopened.json().guide.dismissed, false)
    assert.deepEqual(reopened.json().seed, initial.json().seed)
    const isolated = await host.app.inject({ url: '/api/v1/onboarding/state', headers: headers(other) })
    assert.equal(isolated.statusCode, 200)
    assert.equal(isolated.json().seed.seeded, false)
    assert.deepEqual(isolated.json().guide.completed_steps, [])
  } finally {
    await host?.close(); await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end()
    await rm(root, { recursive: true, force: true })
  }
})
