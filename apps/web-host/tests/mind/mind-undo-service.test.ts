import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { UndoError } from '../../src/modules/undo/undo.js'
import { createHostCoreUndoOperations } from '../../src/modules/undo/persistence/core-operations.js'
import { createPostgresRuntime, type SqlDataRuntime } from '@gugu/core/data'
import { createRuntimeUndoTransactionPort } from '@gugu/core/undo'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const owner = '11111111-1111-4111-8111-111111111111'
async function inSchema(work: (pool: Pool, runtime: SqlDataRuntime) => Promise<void>) {
  const admin = new Pool({ connectionString: url }), schema = `gugu_mind_service_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema} -c timezone=UTC` })
  const runtime = await createPostgresRuntime({ url: url!, schema })
  try {
    await pool.query('CREATE TABLE mind_maps (id int PRIMARY KEY,user_id uuid,title text,project_id int,data_json text,deleted_at timestamptz,updated_at timestamptz)')
    await pool.query(`CREATE TABLE undo_operations (id text PRIMARY KEY,user_id uuid,undo_context_id text,group_id text,resource text,action text,target_refs json,before_state json,after_state json,actor_type text,status text,created_at timestamptz,expires_at timestamptz,undone_at timestamptz,failure_code text)`)
    await work(pool, runtime)
  } finally { await runtime.close(); await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
}
async function insertOperation(pool: Pool, items: Record<string, unknown>) {
  await pool.query("INSERT INTO undo_operations VALUES ('op',$1,'ctx','group','mind','create',$2::json,'{}'::json,$3::json,'web','active',CURRENT_TIMESTAMP,NULL,NULL,NULL)", [owner, JSON.stringify(Object.keys(items).map(key => ({ kind: 'canvas', id: Number(key.split(':')[1]) }))), JSON.stringify({ items })])
}
const snapshot = { title: '原值', project_id: null, data_json: '{}', deleted_at: null }

test('快照冲突提交失败状态且不发布事件', { skip: !url }, async () => inSchema(async (pool, runtime) => {
  await pool.query("INSERT INTO mind_maps VALUES (1,$1,'并发修改',NULL,'{}',NULL,CURRENT_TIMESTAMP)", [owner])
  await insertOperation(pool, { 'canvas:1': snapshot })
  let published = 0
  const service = createHostCoreUndoOperations(pool, createRuntimeUndoTransactionPort(runtime), async () => { published++ })
  await assert.rejects(service.apply(owner, 'ctx', 'op', 'undo'), (error: unknown) => error instanceof UndoError && error.code === 'undo.conflict')
  assert.deepEqual((await pool.query("SELECT status,failure_code FROM undo_operations WHERE id='op'")).rows[0], { status: 'conflicted', failure_code: 'undo.conflict' })
  assert.equal((await pool.query('SELECT deleted_at FROM mind_maps WHERE id=1')).rows[0].deleted_at, null)
  assert.equal(published, 0)
}))

test('多资源写入中途冲突时回滚资源并提交冲突状态', { skip: !url }, async () => inSchema(async (pool, runtime) => {
  await pool.query("INSERT INTO mind_maps VALUES (1,$1,'原值',NULL,'{}',NULL,CURRENT_TIMESTAMP),(2,$1,'原值',NULL,'{}',NULL,CURRENT_TIMESTAMP)", [owner])
  await insertOperation(pool, { 'canvas:1': snapshot, 'canvas:2': snapshot })
  await pool.query("CREATE FUNCTION skip_second() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id=2 THEN RETURN NULL; END IF; RETURN NEW; END $$")
  await pool.query('CREATE TRIGGER skip_second BEFORE UPDATE ON mind_maps FOR EACH ROW EXECUTE FUNCTION skip_second()')
  let published = 0
  const service = createHostCoreUndoOperations(pool, createRuntimeUndoTransactionPort(runtime), async () => { published++ })
  await assert.rejects(service.apply(owner, 'ctx', 'op', 'undo'), (error: unknown) => error instanceof UndoError && error.code === 'undo.conflict')
  assert.deepEqual((await pool.query('SELECT id,deleted_at FROM mind_maps ORDER BY id')).rows, [{ id: 1, deleted_at: null }, { id: 2, deleted_at: null }])
  assert.deepEqual((await pool.query("SELECT status,failure_code FROM undo_operations WHERE id='op'")).rows[0], { status: 'conflicted', failure_code: 'undo.conflict' })
  assert.equal(published, 0)
}))
