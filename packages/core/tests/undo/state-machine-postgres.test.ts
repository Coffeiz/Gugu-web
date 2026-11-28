import assert from 'node:assert/strict'
import { test } from 'vitest'
import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import pg from 'pg'
import { tablesSql } from '../../src/data/schema.js'
import { createPostgresRuntime } from '../../src/data/postgres.js'
import { createRuntimeUndoTransactionPort } from '../../src/undo/state-machine.js'
import { runtimeOperationContract } from './runtime-operation.fixture.js'
import { contract } from './state-machine.fixture.js'

test('PostgreSQL Mind Undo 状态机和跨资源预览', async () => {
  const url = process.env.GUGU_CORE_TEST_POSTGRES_URL
  if (!url) throw new Error('须提供隔离的 PostgreSQL 测试库')
  const admin = new pg.Pool({ connectionString: url }), schema = `gugu_undo_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const runtime = await createPostgresRuntime({ url, schema }), db = runtime.db
  try { await sql.raw(tablesSql('postgres').mindNodes).execute(db); await sql.raw(tablesSql('postgres').undo).execute(db); await sql.raw(tablesSql('postgres').receipts).execute(db); await contract(db, 'postgres', undefined, createRuntimeUndoTransactionPort(runtime)); await runtimeOperationContract(runtime, '11111111-1111-4111-8111-111111111111') }
  finally { await runtime.close(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})

test('PostgreSQL 写入或提交失败回滚，通知失败后重试不重复通知', async () => {
  const { createUndoStateMachine } = await import('../../src/undo/state-machine.js')
  const url = process.env.GUGU_CORE_TEST_POSTGRES_URL
  if (!url) throw new Error('须提供隔离的 PostgreSQL 测试库')
  const admin = new pg.Pool({ connectionString: url }), schema = `gugu_undo_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const runtime = await createPostgresRuntime({ url, schema }), db = runtime.db
  try {
    await sql.raw(tablesSql('postgres').mindNodes).execute(db)
    await sql.raw(tablesSql('postgres').undo).execute(db)
    const owner = '11111111-1111-4111-8111-111111111111', stamp = '2026-01-01 00:00:00.000000+00:00'
    await db.insertInto('mind_nodes').values({ id: 1, user_id: owner, kind: 'note', title: '测试', content_md: '', content_plain: '', color: null, ref_type: null, ref_id: null, ref_snapshot: null, origin: 'user', indexed_at: null, indexed_hash: null, version: 1, captured_at: stamp, created_at: stamp, updated_at: stamp, deleted_at: null }).execute()
    const snapshot = { kind: 'note', title: '测试', content_md: '', content_plain: '', color: null, captured_at: stamp, deleted_at: null }
    await db.insertInto('undo_operations').values({ id: 'failure', user_id: owner, undo_context_id: 'ctx', group_id: 'failure', resource: 'mind', action: 'create', target_refs: '[1]', before_state: '{}', after_state: JSON.stringify({ items: { 'note:1': snapshot } }), base_versions: '{}', artifact_refs: '{}', actor_type: 'web', status: 'active', created_at: stamp, undone_at: null, expires_at: null, failure_code: null }).execute()
    let notifications = 0
    const api = createUndoStateMachine(createRuntimeUndoTransactionPort(runtime), async () => { notifications++; throw new Error('通知失败') })
    const unchanged = async () => {
      assert.equal((await db.selectFrom('mind_nodes').selectAll().where('id', '=', 1).executeTakeFirstOrThrow()).deleted_at, null)
      assert.equal((await db.selectFrom('undo_operations').selectAll().where('id', '=', 'failure').executeTakeFirstOrThrow()).status, 'active')
      assert.equal(notifications, 0)
    }
    await sql.raw("CREATE FUNCTION undo_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '写入失败'; END $$").execute(db)
    await sql.raw('CREATE TRIGGER undo_test_failure BEFORE UPDATE ON undo_operations FOR EACH ROW EXECUTE FUNCTION undo_test_failure()').execute(db)
    await assert.rejects(api.apply(owner, 'ctx', 'failure', 'undo'), /写入失败/)
    await unchanged()
    await sql.raw('DROP TRIGGER undo_test_failure ON undo_operations').execute(db)
    await sql.raw("CREATE OR REPLACE FUNCTION undo_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '提交失败'; END $$").execute(db)
    await sql.raw('CREATE CONSTRAINT TRIGGER undo_test_failure AFTER UPDATE ON undo_operations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION undo_test_failure()').execute(db)
    await assert.rejects(api.apply(owner, 'ctx', 'failure', 'undo'), /提交失败/)
    await unchanged()
    await sql.raw('DROP TRIGGER undo_test_failure ON undo_operations').execute(db)
    await assert.rejects(api.apply(owner, 'ctx', 'failure', 'undo'), /通知失败/)
    assert.ok((await db.selectFrom('mind_nodes').selectAll().where('id', '=', 1).executeTakeFirstOrThrow()).deleted_at)
    assert.equal((await db.selectFrom('undo_operations').selectAll().where('id', '=', 'failure').executeTakeFirstOrThrow()).status, 'undone')
    assert.equal(notifications, 1)
    assert.equal((await api.apply(owner, 'ctx', 'failure', 'undo')).idempotent, true)
    assert.equal(notifications, 1)
  } finally { await runtime.close(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
