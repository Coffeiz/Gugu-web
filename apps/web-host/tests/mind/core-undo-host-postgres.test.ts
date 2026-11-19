import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { createApp } from '../../src/app.js'
import { createHostCoreUndoOperations } from '../../src/modules/undo/persistence/core-operations.js'
import { createPostgresRuntime } from '@gugu/core/data'
import { createRuntimeUndoTransactionPort } from '@gugu/core/undo'
import { signedUserToken } from '../helpers/auth.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const secret = 'synthetic-undo-secret'
const owner = 'e2dc7e3a-e0a7-4ce3-a782-3efb560c6d91'
const other = '207037b2-4f13-458c-8b85-c50fa49a2c34'

test('认证 Host 通过 Core Undo 映射 404、冲突、幂等与通知', { skip: !databaseUrl }, async () => {
  const admin = new Pool({ connectionString: databaseUrl })
  const schema = `gugu_undo_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` })
  const runtime = await createPostgresRuntime({ url: databaseUrl!, schema })
  try {
    await pool.query(`CREATE TABLE mind_nodes (id integer PRIMARY KEY, user_id uuid NOT NULL, kind text, title text, content_md text, content_plain text, color text, captured_at timestamptz, deleted_at timestamptz, version integer, ref_snapshot json, updated_at timestamptz)`)
    await pool.query(`CREATE TABLE undo_operations (id text PRIMARY KEY, user_id uuid, undo_context_id text, group_id text, resource text, action text, target_refs json, before_state json, after_state json, actor_type text, status varchar(16), created_at timestamptz, expires_at timestamptz, undone_at timestamptz, failure_code text)`)
    const snapshot = { id: 1, kind: 'note', title: null, content_md: '正文', content_plain: '正文', color: null, captured_at: '2026-01-01T00:00:00.000Z', deleted_at: null, version: 1 }
    await pool.query(`INSERT INTO mind_nodes VALUES (1,$1,'note',NULL,'正文','正文',NULL,$2,NULL,1,NULL,CURRENT_TIMESTAMP)`, [owner, snapshot.captured_at])
    await pool.query(`INSERT INTO undo_operations VALUES ('op',$1,'ctx','group','mind','create',$2::json,'{}'::json,$3::json,'web','active',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+interval '1 day',NULL,NULL)`, [owner, JSON.stringify([{ kind: 'note', id: 1 }]), JSON.stringify({ items: { 'note:1': snapshot } })])
    const events: Record<string, unknown>[] = []
    const app = createApp({ appName: 'Gugu', isReady: async () => true, userAuth: { secret, lookupUser: async id => ({ id, username: 'synthetic', displayName: null, email: 'synthetic@example.test', isActive: true, accountStatus: 'active', securityVersion: 1, avatarUrl: null, createdAt: null, timezone: null, emailSubscribed: false, imChannels: [] }) }, undo: createHostCoreUndoOperations(pool, createRuntimeUndoTransactionPort(runtime), async (_owner, event) => { events.push(event) }) })
    try {
      const auth = (id: string) => ({ authorization: `Bearer ${signedUserToken(secret, id)}` })
      assert.equal((await app.inject({ method: 'GET', url: '/api/v1/undo/preview?context_id=ctx' })).statusCode, 401)
      const preview = await app.inject({ method: 'GET', url: '/api/v1/undo/preview?context_id=ctx', headers: auth(owner) })
      assert.equal(preview.json().undo.operation_id, 'op')
      const foreign = await app.inject({ method: 'POST', url: '/api/v1/undo', headers: auth(other), payload: { operation_id: 'op', context_id: 'ctx' } })
      assert.equal(foreign.statusCode, 404)
      assert.equal(foreign.json().detail.code, 'undo.not_found')
      const undo = await app.inject({ method: 'POST', url: '/api/v1/undo', headers: auth(owner), payload: { operation_id: 'op', context_id: 'ctx' } })
      assert.equal(undo.statusCode, 200)
      assert.ok((await pool.query('SELECT deleted_at FROM mind_nodes WHERE id=1')).rows[0].deleted_at)
      const repeated = await app.inject({ method: 'POST', url: '/api/v1/undo', headers: auth(owner), payload: { operation_id: 'op', context_id: 'ctx' } })
      assert.equal(repeated.statusCode, 200)
      assert.equal(repeated.json().idempotent, true)
      assert.equal(events.length, 1)
      const redo = await app.inject({ method: 'POST', url: '/api/v1/undo/redo', headers: auth(owner), payload: { operation_id: 'op', context_id: 'ctx' } })
      assert.equal(redo.statusCode, 200)
      const row = (await pool.query('SELECT deleted_at, version FROM mind_nodes WHERE id=1')).rows[0]
      assert.equal(row.deleted_at, null)
      assert.equal(row.version, 3)
      assert.deepEqual(events.map(event => event.operation), ['delete', 'create'])
      await pool.query("UPDATE mind_nodes SET title='外部修改' WHERE id=1")
      const conflict = await app.inject({ method: 'POST', url: '/api/v1/undo', headers: auth(owner), payload: { operation_id: 'op', context_id: 'ctx' } })
      assert.equal(conflict.statusCode, 409)
      assert.equal(conflict.json().detail.code, 'undo.conflict')
      assert.equal(events.length, 2)
    } finally { await app.close() }
  } finally {
    await runtime.close()
    await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin.end()
  }
})
