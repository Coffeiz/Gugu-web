import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { Pool } from 'pg'
import test from 'node:test'
import { tablesSql } from '../../../../../../packages/core/src/data/schema.js'
import { startServer } from '../../../../src/main.js'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL
test('生产管理员通知历史经过真实认证和Core PG，删除幂等且不删任务通知', { skip: !url && '需要隔离PG' }, async () => {
  const schema = `notification_host_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const scoped = new URL(url!)
  scoped.searchParams.set('options', `-c search_path=${schema}`)
  const pool = new Pool({ connectionString: scoped.toString() })
  const root = await mkdtemp(join(tmpdir(), 'gugu-notification-admin-'))
  let host: Awaited<ReturnType<typeof startServer>> | undefined
  try {
    await pool.query(tablesSql('postgres').siteNotifications)
    await pool.query('CREATE TABLE audit_logs(id serial PRIMARY KEY,username text NOT NULL,action text NOT NULL,description text NOT NULL,ip text,created_at timestamptz NOT NULL)')
    await pool.query(`INSERT INTO site_notifications(id,title,content,color,target,bubble,persist,created_by,created_at)
      VALUES(1,'后台广播','内容','#abc','all',true,true,'admin','2026-01-01T00:00:00.123456Z'),
      (2,'任务通知','内容','#abc','all',true,true,'scheduled_task','2026-01-02T00:00:00Z')`)
    await pool.query('CREATE TABLE system_logs(id serial PRIMARY KEY,level varchar(20) NOT NULL,module varchar(200) NOT NULL,message text NOT NULL,traceback text,created_at timestamptz NOT NULL)')
    await pool.query("INSERT INTO system_logs(level,module,message,created_at) VALUES('ERROR','synthetic','合成错误','2026-01-01T00:00:00.123456Z')")
    await pool.query('CREATE TABLE files(id serial PRIMARY KEY,size_bytes bigint NOT NULL)')
    await pool.query('CREATE TABLE chat_attachments(id serial PRIMARY KEY,state text NOT NULL,size bigint NOT NULL)')
    await pool.query('INSERT INTO files(size_bytes) VALUES(100),(200)')
    await pool.query("INSERT INTO chat_attachments(state,size) VALUES('draft',50),('attached',100)")
    await pool.query('CREATE TABLE users(id uuid PRIMARY KEY,email text,is_active boolean,account_status text,email_subscribed boolean)')
    await pool.query('CREATE TABLE user_preferences(user_id uuid PRIMARY KEY,data_json text)')
    await pool.query("INSERT INTO users VALUES('00000000-0000-4000-8000-000000000001','synthetic@example.test',true,'active',true)")
    const override = join(root, 'config.json')
    await writeFile(override, JSON.stringify({ safe_egress: { enabled: true, proxy_url: 'http://proxy.example.test:8080', proxy_auth_secret: 'synthetic-encrypted-secret' } }))
    const server = createServer()
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    await new Promise<void>(resolve => server.close(() => resolve()))
    host = await startServer({ GUGU_WEBUI_DATABASE_URL: scoped.toString(), GUGU_WEBUI_SECRET_KEY: 'synthetic-notification-secret',
      GUGU_CONFIG_OVERRIDE_FILE: override, GUGU_WEBUI_HOST: '127.0.0.1', GUGU_WEBUI_PORT: String(address.port), GUGU_WEBUI_REDIS_URL: '',
      STORAGE__LOCAL_PATH: root, ADMIN_USERNAME: 'synthetic-admin', ADMIN_PASSWORD: 'synthetic-password' })
    assert.equal((await host.app.inject({ url: '/api/v1/admin/notifications/history' })).statusCode, 401)
    const login = await host.app.inject({ method: 'POST', url: '/api/v1/admin/auth/login', payload: { username: 'synthetic-admin', password: 'synthetic-password' } })
    assert.equal(login.statusCode, 200)
    const headers = { authorization: `Bearer ${login.json().access_token}` }
    assert.equal((await host.app.inject({ url: '/api/v1/admin/system-logs' })).statusCode, 401)
    const logs = await host.app.inject({ url: '/api/v1/admin/system-logs?level=error', headers })
    assert.equal(logs.statusCode, 200)
    assert.deepEqual(logs.json(), { items: [{ id: 1, level: 'ERROR', module: 'synthetic', message: '合成错误', traceback: null, created_at: '2026-01-01T00:00:00.123456+00:00' }] })
    assert.equal((await host.app.inject({ url: '/api/v1/admin/safe-egress' })).statusCode, 401)
    const egress = await host.app.inject({ url: '/api/v1/admin/safe-egress', headers })
    assert.equal(egress.statusCode, 200)
    assert.deepEqual(egress.json(), { enabled: true, proxy_url: 'http://proxy.example.test:8080', has_auth: true })
    assert.equal(egress.body.includes('synthetic-encrypted-secret'), false)
    assert.equal((await host.app.inject({ url: '/api/v1/admin/ops/storage-live-totals' })).statusCode, 401)
    const totals = await host.app.inject({ url: '/api/v1/admin/ops/storage-live-totals', headers })
    assert.equal(totals.statusCode, 200)
    assert.deepEqual(totals.json(), { categories: { chat_staging_draft: {object_count:1,total_bytes:50},chat_staging_attached: {object_count:1,total_bytes:100},user_files: {object_count:2,total_bytes:300} } })
    assert.equal((await host.app.inject({ url: '/api/v1/admin/email/recipient-count' })).statusCode, 401)
    const recipientCount = await host.app.inject({ url: '/api/v1/admin/email/recipient-count', headers })
    assert.equal(recipientCount.statusCode, 200)
    assert.deepEqual(recipientCount.json(), {count:1,locale_counts:{'zh-CN':1,'ja-JP':0,'en-US':0}})
    assert.equal(recipientCount.body.includes('synthetic@example.test'),false)
    for(const path of ['/api/v1/admin/config/index-rebuild/status','/api/v1/admin/config/memory-cleanup/status','/api/v1/admin/agent/memory/im-scopes/maintenance/model-preview/status'])assert.equal((await host.app.inject({url:path,headers})).statusCode,503)
    const response = await host.app.inject({ url: '/api/v1/admin/notifications/history', headers })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json().map((r: {id: number}) => r.id), [1])
    assert.equal(response.json()[0].created_at, '2026-01-01T00:00:00.123456+00:00')
    for (const id of [2, 1, 1]) assert.deepEqual((await host.app.inject({ method: 'DELETE', url: `/api/v1/admin/notifications/history/${id}`, headers })).json(), { ok: true })
    assert.deepEqual((await pool.query('SELECT id FROM site_notifications')).rows, [{ id: 2 }])
  } finally {
    await host?.close()
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
    await rm(root, { recursive: true, force: true })
  }
})
