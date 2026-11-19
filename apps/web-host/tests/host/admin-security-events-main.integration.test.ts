import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Pool } from 'pg'
import { applySecurityEventsMigration } from '../../src/migrations/security-events-migrate.js'
import { createSecurityEventFingerprint } from '../../src/modules/admin/audit.js'
import { startServer } from '../../src/main.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return address.port
}

test('生产 Host 安全事件 API 经 Core 查询正式迁移的 PostgreSQL，管理员认证、筛选与字段脱敏符合基线', {
  skip: !databaseUrl && '需要显式隔离 PostgreSQL',
}, async () => {
  const schema = `admin_security_events_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  const root = await mkdtemp(join(tmpdir(), 'gugu-admin-security-events-'))
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const scoped = new URL(databaseUrl!)
  scoped.searchParams.set('options', `-c search_path=${schema}`)
  const pool = new Pool({ connectionString: scoped.toString(), max: 3 })
  const owner = randomUUID(), other = randomUUID()
  const secret = 'synthetic-admin-security-events-secret'
  let host: Awaited<ReturnType<typeof startServer>> | undefined
  try {
    await pool.query(`CREATE TABLE users(
      id uuid PRIMARY KEY, username text, email text, display_name text, is_active boolean,
      account_status text, suspended_until timestamptz, suspended_reason text, security_version integer,
      is_developer boolean, created_at timestamptz, updated_at timestamptz,
      token_limit_6h bigint, token_limit_weekly bigint, storage_limit_bytes bigint, search_limit_daily integer
    );
    CREATE TABLE agent_usage(user_id uuid, tokens_in bigint, tokens_out bigint, created_at timestamptz, is_byok boolean);
    CREATE TABLE files(user_id uuid, size_bytes bigint);
    CREATE TABLE storage_quota_ledgers(user_id uuid, category text, used_bytes bigint);`)
    await applySecurityEventsMigration(pool)
    await pool.query(`INSERT INTO users(
      id,username,email,display_name,is_active,account_status,security_version,is_developer,created_at,updated_at,
      token_limit_6h,token_limit_weekly,storage_limit_bytes,search_limit_daily
    ) VALUES
      ($1,'synthetic-owner','owner@example.test','合成属主',true,'active',2,false,now()-interval '1 day',now(),100,700,4096,20),
      ($2,'synthetic-other','other@example.test',NULL,true,'active',1,false,now()-interval '2 days',now()-interval '2 days',NULL,NULL,NULL,NULL)`, [owner, other])
    await pool.query(`INSERT INTO agent_usage VALUES
      ($1,3,4,now()-interval '1 minute',false),($1,100,100,now()-interval '1 minute',true)`, [owner])
    await pool.query('INSERT INTO files(user_id,size_bytes) VALUES($1,40)', [owner])
    await pool.query("INSERT INTO storage_quota_ledgers(user_id,category,used_bytes) VALUES($1,'file_library',55)", [owner])
    await pool.query(`INSERT INTO security_events (
      user_id,event_type,resource_type,resource_fingerprint,owner_fingerprint,client_fingerprint,
      ip_fingerprint,user_agent_fingerprint,action,reason_code,metadata_json,occurred_at,expires_at
    ) VALUES
      ($1,'ownership.denied','Project','resource-a','owner-a','client-a','ip-a','ua-secret','logged','ownership_mismatch','{"private":"must-not-leak"}',date_trunc('second',now())-interval '1 minute'+interval '123456 microseconds',now()+interval '1 day'),
      ($1,'ownership.denied','File','resource-b','owner-b','client-b','ip-b','ua-secret','blocked','ownership_mismatch','{"private":"must-not-leak"}',now()-interval '10 minutes',now()+interval '1 day'),
      ($2,'ownership.denied','Project','resource-c','owner-c','client-c','ip-c','ua-secret','logged','ownership_mismatch','{"private":"must-not-leak"}',now()-interval '2 hours',now()+interval '1 day')`,
    [owner, other])
    const configPath = join(root, 'config.test.json')
    await writeFile(configPath, '{}')
    host = await startServer({
      GUGU_WEBUI_DATABASE_URL: scoped.toString(), GUGU_WEBUI_SECRET_KEY: secret,
      GUGU_CONFIG_OVERRIDE_FILE: configPath, STORAGE__LOCAL_PATH: join(root, 'storage'),
      GUGU_WEBUI_HOST: '127.0.0.1', GUGU_WEBUI_PORT: String(await freePort()),
      GUGU_WEBUI_REDIS_URL: '', ADMIN_USERNAME: 'synthetic-admin', ADMIN_PASSWORD: 'synthetic-password',
    })
    assert.equal((await host.app.inject({ url: '/api/v1/admin/audit-log/security-events' })).statusCode, 401)
    assert.equal((await host.app.inject({ url: `/api/v1/admin/users/${owner}/security-events` })).statusCode, 401)
    const login = await host.app.inject({ method: 'POST', url: '/api/v1/admin/auth/login', payload: {
      username: 'synthetic-admin', password: 'synthetic-password',
    } })
    assert.equal(login.statusCode, 200, login.body)
    const headers = { authorization: `Bearer ${login.json().access_token}` }
    const users = await host.app.inject({ url: '/api/v1/admin/users?q=SYNTHETIC-OWNER', headers })
    assert.equal(users.statusCode, 200, users.body)
    assert.deepEqual([users.json().total, users.json().items[0]?.tokens_week, users.json().items[0]?.tokens_6h,
      users.json().items[0]?.storage_used], [1, 7, 7, 55])
    const risk = await host.app.inject({ url: '/api/v1/admin/users/risk?window_minutes=60', headers })
    assert.equal(risk.statusCode, 200, risk.body)
    assert.deepEqual(risk.json().items.map((item: { id: string }) => item.id), [owner])
    assert.deepEqual([risk.json().items[0].visible_event_count, risk.json().items[0].recent_event_count], [2, 1])
    const global = await host.app.inject({
      url: `/api/v1/admin/audit-log/security-events?event_type=ownership.denied&action=logged&resource_type=Project&user_id=${owner}&since_minutes=60&limit=1`,
      headers,
    })
    assert.equal(global.statusCode, 200, global.body)
    assert.deepEqual(global.json(), {
      items: [{
        id: 1, user_id: createSecurityEventFingerprint(secret)(owner), event_type: 'ownership.denied',
        resource_type: 'Project', resource_fingerprint: 'resource-a', owner_fingerprint: 'owner-a',
        client_fingerprint: 'client-a', ip_fingerprint: 'ip-a', user_agent_fingerprint: 'ua-secret',
        action: 'logged', reason_code: 'ownership_mismatch',
        occurred_at: global.json().items[0].occurred_at,
      }], total: 1, since_minutes: 60,
    })
    assert.match(global.json().items[0].occurred_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$/)
    assert.ok(global.json().items[0].occurred_at.endsWith('.123456+00:00'), '保留 PostgreSQL 的完整微秒精度')
    assert.equal(JSON.stringify(global.json()).includes(owner), false)
    assert.equal(JSON.stringify(global.json()).includes('must-not-leak'), false)

    const user = await host.app.inject({ url: `/api/v1/admin/users/${owner}/security-events?limit=1`, headers })
    assert.equal(user.statusCode, 200, user.body)
    assert.equal(user.json().items.length, 1)
    assert.ok(user.json().items[0].occurred_at.endsWith('.123456+00:00'), '用户事件也保留 PostgreSQL 的完整微秒精度')
    assert.deepEqual(Object.keys(user.json().items[0]).sort(), [
      'action', 'client_fingerprint', 'event_type', 'id', 'ip_fingerprint', 'occurred_at',
      'owner_fingerprint', 'reason_code', 'resource_fingerprint', 'resource_type',
    ])
    assert.equal(JSON.stringify(user.json()).includes(owner), false)
    assert.equal(JSON.stringify(user.json()).includes('ua-secret'), false)
    assert.equal((await host.app.inject({ url: `/api/v1/admin/users/${randomUUID()}/security-events`, headers })).statusCode, 404)
    for (const url of [
      '/api/v1/admin/audit-log/security-events?limit=501',
      '/api/v1/admin/audit-log/security-events?since_minutes=0',
      '/api/v1/admin/audit-log/security-events?user_id=bad',
      `/api/v1/admin/users/${owner}/security-events?limit=501`,
    ]) assert.equal((await host.app.inject({ url, headers })).statusCode, 422, url)
  } finally {
    await host?.close()
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
    await rm(root, { recursive: true, force: true })
  }
})
