import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { createHostCoreUndoOperations } from '../../src/modules/undo/service.js'
import { createPostgresRuntime } from '@gugu/core/data'
import { createRuntimeUndoTransactionPort } from '@gugu/core/undo'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL
test('日历撤销与重做持久化提醒、隔离用户并串行化并发请求', { skip: !url }, async () => {
  const admin = new Pool({ connectionString: url })
  const schema = `gugu_calendar_undo_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  const runtime = await createPostgresRuntime({ url: url!, schema })
  try {
    await pool.query(`CREATE TABLE calendar_events (id integer PRIMARY KEY,user_id text, title text, date text, time text,end_time text,type text,contact_name text,project_id integer,description text,version integer,deleted_at timestamptz)`)
    await pool.query(`CREATE TABLE scheduled_tasks (id integer PRIMARY KEY,user_id text,enabled boolean,name text,payload text,cron text UNIQUE,schedule_kind text,start_at timestamptz,reminder_lead_minutes integer,channels text,delivery_targets json,updated_at timestamptz)`)
    await pool.query(`CREATE TABLE rag_index_jobs(id bigserial PRIMARY KEY,user_id text NOT NULL,source_type text NOT NULL,source_id text NOT NULL,pending_source_ids json,version text NOT NULL,operation text NOT NULL,status text NOT NULL,generation int NOT NULL,completed_generation int NOT NULL,attempts int NOT NULL,next_attempt_at timestamptz,lease_until timestamptz,last_error_code text,last_started_at timestamptz,last_succeeded_at timestamptz,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,UNIQUE(user_id,source_type))`)
    await pool.query(`CREATE TABLE undo_operations (id text PRIMARY KEY,user_id text,undo_context_id text,group_id text,resource text,action text,target_refs json,before_state json,after_state json,actor_type text,status varchar(16),created_at timestamptz,expires_at timestamptz,undone_at timestamptz,failure_code text)`)
    await pool.query(`INSERT INTO calendar_events VALUES (1,'11111111-1111-4111-8111-111111111111','新','2026-01-01',NULL,NULL,'event',NULL,NULL,NULL,2,NULL)`)
    await pool.query(`INSERT INTO scheduled_tasks VALUES (2,'11111111-1111-4111-8111-111111111111',true,'提醒','','new','once',NULL,5,'web',NULL)`)
    const before = { items: { 'event:1': { title: '旧', client: '旧联系人', version: 1 }, 'task:2': { enabled: true, cron: 'old' } } }
    const after = { items: { 'event:1': { title: '新', client: '新联系人', version: 2 }, 'task:2': { enabled: true, cron: 'new' } } }
    await pool.query(`INSERT INTO undo_operations VALUES ('op','11111111-1111-4111-8111-111111111111','ctx','group','calendar','update','[]',$1::json,$2::json,'web','active',now(),now()+interval '1 day',NULL,NULL)`, [JSON.stringify(before), JSON.stringify(after)])
    const events: unknown[] = []
    const service = createHostCoreUndoOperations(pool, createRuntimeUndoTransactionPort(runtime), async (_owner, event) => { events.push(event) })
    await assert.rejects(() => service.apply('22222222-2222-4222-8222-222222222222', 'ctx', 'op', 'undo'))
    const results = await Promise.all([service.apply('11111111-1111-4111-8111-111111111111', 'ctx', 'op', 'undo'), service.apply('11111111-1111-4111-8111-111111111111', 'ctx', 'op', 'undo')]) as Array<{ idempotent: boolean }>
    assert.deepEqual(results.map(result => result.idempotent).sort(), [false, true])
    assert.equal((await pool.query('SELECT title FROM calendar_events WHERE id=1')).rows[0].title, '旧')
    assert.equal((await pool.query('SELECT contact_name FROM calendar_events WHERE id=1')).rows[0].contact_name, '旧联系人')
    assert.equal((await pool.query('SELECT cron FROM scheduled_tasks WHERE id=2')).rows[0].cron, 'old')
    await service.apply('11111111-1111-4111-8111-111111111111', 'ctx', 'op', 'redo')
    assert.equal((await pool.query('SELECT title FROM calendar_events WHERE id=1')).rows[0].title, '新')
    assert.equal((await pool.query('SELECT contact_name FROM calendar_events WHERE id=1')).rows[0].contact_name, '新联系人')
    assert.equal((await pool.query('SELECT cron FROM scheduled_tasks WHERE id=2')).rows[0].cron, 'new')
    assert.deepEqual((await pool.query(`SELECT source_id,pending_source_ids,generation FROM rag_index_jobs WHERE user_id=$1 AND source_type='scheduled_task'`, ['11111111-1111-4111-8111-111111111111'])).rows[0], { source_id: '2', pending_source_ids: ['2'], generation: 2 })
    assert.equal(events.length, 4)
  } finally {
    await runtime.close()
    await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin.end()
  }
})
