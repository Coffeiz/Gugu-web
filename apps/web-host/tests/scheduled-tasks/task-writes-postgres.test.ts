import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { createApp } from '../../src/app.js'
import { signedUserToken } from '../helpers/auth.js'
import { createPostgresTaskWrites } from '../../src/modules/scheduled-tasks/persistence/task-writes-postgres.js'
import { createPostgresTaskResolver } from '../../src/modules/scheduled-tasks/persistence/task-resolver-postgres.js'
import { createPostgresTaskExternal } from '../../src/modules/scheduled-tasks/persistence/task-external-postgres.js'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL
test('活动提醒创建幂等、更新受 owner 限制且验证失败回滚', { skip: !url }, async () => {
  const admin = new Pool({ connectionString: url }), schema = `gugu_task_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  const owner = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222'
  try {
    await pool.query(`CREATE TABLE calendar_events(id int PRIMARY KEY,user_id uuid,deleted_at timestamptz,date text,time text);
      CREATE TABLE workspaces(id int PRIMARY KEY,user_id uuid,enabled boolean);
      CREATE TABLE files(id int PRIMARY KEY,user_id uuid,deleted_at timestamptz);
      CREATE TABLE user_bots(id int PRIMARY KEY,user_id uuid,platform text,enabled boolean,owner_platform_user_id text);
      CREATE TABLE conversation_sessions(id int PRIMARY KEY,user_id uuid,source text,chat_type text,chat_id text,bot_id text);
      CREATE TABLE filesystem_authorization_grants(id int PRIMARY KEY,user_id uuid,revoked_at timestamptz,updated_at timestamptz);
      CREATE TABLE security_events(user_id uuid,event_type text,resource_type text,resource_fingerprint text,owner_fingerprint text,client_fingerprint text,ip_fingerprint text,user_agent_fingerprint text,action text,reason_code text,metadata_json jsonb,occurred_at timestamptz,expires_at timestamptz);
      CREATE TABLE scheduled_tasks(id serial PRIMARY KEY,user_id uuid,event_id int,workspace_id int,filesystem_authorization_grant_id int,name text,payload text,cron text,schedule_kind text,interval_minutes int,start_at timestamptz,end_at timestamptz,channels text,enabled boolean,delivery_targets json,authorized_tools json,email_attachment_file_ids json,reminder_lead_minutes int,last_run_at timestamptz,last_run_failed boolean,created_at timestamptz,updated_at timestamptz);
      CREATE UNIQUE INDEX task_event ON scheduled_tasks(user_id,event_id,cron) WHERE event_id IS NOT NULL;
      CREATE TABLE undo_operations(id text PRIMARY KEY,user_id uuid,undo_context_id text,actor_type text,resource text,action text,status text,created_at timestamptz,after_state json,target_refs json,base_versions json)`)
    await pool.query("INSERT INTO calendar_events VALUES(1,$1,NULL,'2099-01-01','09:00')", [owner])
    await pool.query('INSERT INTO workspaces VALUES (1,$1,TRUE),(2,$2,TRUE)', [owner, other])
    await pool.query('INSERT INTO files VALUES (1,$1,NULL),(2,$2,NULL)', [owner, other])
    await pool.query("INSERT INTO user_bots VALUES (10,$1,'qq',TRUE,'owner'),(11,$2,'qq',TRUE,'other')", [owner, other])
    await pool.query("INSERT INTO conversation_sessions VALUES (1,$1,'qq','group','owned','10'),(2,$2,'qq','group','foreign','11')", [owner, other])
    let reject = false, events = 0
    let revoked = 0
    const external = createPostgresTaskExternal({ secretKey: 'synthetic-secret', async readWechatPrivate() { return null }, async revokeConfirmation() { revoked++ } })
    const resolve = createPostgresTaskResolver({ ...external, async resolveDelivery(...args) { if (reject) throw new Error('目标不可用'); return external.resolveDelivery(...args) } })
    const writes = createPostgresTaskWrites(pool, { validateCron() {}, filesystemAuthorizationEnabled: () => false,
      resolve,
      async publish() { events++ },
    })
    const input = { name: '提醒', schedule_kind: 'once', start_at: '2099-01-01T08:00:00.123456', event_id: 1, workspace_id: 1, email_attachment_file_ids: [1,1] }
    const secret = 'synthetic-task-write-secret'
    const app = createApp({ appName: 'Gugu', isReady: async () => true,
      userAuth: { secret, lookupUser: async id => ({ id, username: 'synthetic', displayName: null, email: 'synthetic@example.test', isActive: true, accountStatus: 'active', securityVersion: 1, avatarUrl: null, createdAt: null, timezone: null, emailSubscribed: false, imChannels: [] }) },
      scheduledTaskWrites: writes,
    })
    try {
      assert.equal((await app.inject({ method: 'POST', url: '/api/v1/scheduled-tasks', payload: input })).statusCode, 401)
      const headers = { authorization: `Bearer ${signedUserToken(secret, owner)}` }
      const created = await app.inject({ method: 'POST', url: '/api/v1/scheduled-tasks', headers, payload: input })
      assert.equal(created.statusCode, 201, created.body)
      const duplicate = await app.inject({ method: 'POST', url: '/api/v1/scheduled-tasks', headers, payload: input })
      assert.equal(duplicate.statusCode, 200, duplicate.body)
      assert.equal(duplicate.json().id, created.json().id)
      const foreignHeaders = { authorization: `Bearer ${signedUserToken(secret, other)}` }
      assert.equal((await app.inject({ method: 'PATCH', url: `/api/v1/scheduled-tasks/${created.json().id}`, headers: foreignHeaders, payload: { name: '越权' } })).statusCode, 404)
      const invalid = await app.inject({ method: 'PATCH', url: `/api/v1/scheduled-tasks/${created.json().id}`, headers, payload: { name: '必须回滚', workspace_id: 2 } })
      assert.equal(invalid.statusCode, 400)
      assert.equal((await pool.query('SELECT name FROM scheduled_tasks WHERE id=$1', [created.json().id])).rows[0].name, '提醒')
    } finally { await app.close() }
    const [a, b] = await Promise.all([writes.create(owner, input, null, null), writes.create(owner, input, null, null)])
    assert.equal(a.task.id, b.task.id)
    assert.equal(a.task.start_at, '2099-01-01T00:00:00.123456Z')
    assert.equal(events, 1)
    await assert.rejects(writes.create(owner, { ...input, workspace_id: 2 }, null, null), /工作区不存在/)
    await assert.rejects(writes.create(owner, { ...input, email_attachment_file_ids: [2] }, null, null), /附件不存在/)
    await assert.rejects(writes.update(other, a.task.id, { name: '越权' }, null), /任务不存在/)
    reject = true
    await assert.rejects(writes.update(owner, a.task.id, { name: '失败', channels: ['web'] }, null), /目标不可用/)
    assert.equal((await pool.query('SELECT name FROM scheduled_tasks WHERE id=$1', [a.task.id])).rows[0].name, '提醒')
    reject = false
    await assert.rejects(writes.update(owner, a.task.id, { workspace_id: 2 }, null), /工作区不存在/)
    await assert.rejects(writes.update(owner, a.task.id, { email_attachment_file_ids: [2] }, null), /附件不存在/)
    const updated = await writes.update(owner, a.task.id, { name: '新提醒' }, null)
    assert.equal(updated.name, '新提醒')
    assert.equal(updated.start_at, '2099-01-01T00:00:00.123456Z')
    assert.equal(events, 2)
    await pool.query('UPDATE workspaces SET enabled=FALSE WHERE id=1')
    await pool.query('UPDATE files SET deleted_at=now() WHERE id=1')
    reject = true
    const retained = await writes.update(owner, a.task.id, { name: '仍可修改', channels: null }, null)
    assert.equal(retained.name, '仍可修改')
    assert.equal(retained.workspace_id, 1)
    assert.deepEqual(retained.email_attachment_file_ids, [1])
    await assert.rejects(writes.update(owner, a.task.id, { workspace_id: 1 }, null), /工作区不存在/)
    await assert.rejects(writes.update(owner, a.task.id, { email_attachment_file_ids: [1] }, null), /附件不存在/)
    reject = false
    await pool.query('UPDATE workspaces SET enabled=TRUE WHERE id=1')
    await pool.query('UPDATE files SET deleted_at=NULL WHERE id=1')
    assert.deepEqual((await writes.update(owner, a.task.id, { email_attachment_file_ids: null }, null)).email_attachment_file_ids, [])
    const rescheduled = await writes.update(owner, a.task.id, { end_at: null }, null)
    assert.equal(rescheduled.start_at, '2099-01-01T00:00:00.123456Z')
    assert.equal(rescheduled.cron, '@once:2099-01-01T00:00:00.123456+00:00')
    const standalone = await writes.create(owner, { name: '任务', schedule_kind: 'interval', interval_minutes: 5, channels: ['qq'], qq_delivery: { mode: 'group', chat_id: 'owned' } }, null, null)
    assert.equal((standalone.delivery_targets as any).qq.chat_id, 'owned')
    await assert.rejects(writes.update(owner, standalone.task.id, { channels: ['qq'], qq_delivery: { mode: 'group', chat_id: 'foreign' } }, null), /找不到该群会话/)
    await pool.query('INSERT INTO filesystem_authorization_grants VALUES(5,$1,NULL,NULL)', [owner])
    await pool.query('UPDATE scheduled_tasks SET filesystem_authorization_grant_id=5 WHERE id=$1', [standalone.task.id])
    await writes.update(owner, standalone.task.id, { enabled: false }, null)
    assert.equal(revoked, 1)
    assert.ok((await pool.query('SELECT revoked_at FROM filesystem_authorization_grants WHERE id=5')).rows[0].revoked_at)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM security_events')).rows[0].n, 1)
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
