import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { applyMindUndoCore } from '../../src/modules/undo/persistence/mind-core.js'
import { MindUndoConflict } from '../../src/modules/undo/persistence/mind.js'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const owner = '11111111-1111-4111-8111-111111111111'
async function inSchema(work: (client: PoolClient) => Promise<void>) {
  const admin = new Pool({ connectionString: url }), schema = `gugu_mind_adapter_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema} -c timezone=UTC` })
  const client = await pool.connect()
  try { await work(client) } finally { client.release(); await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
}

test('便签创建撤销后递增版本，重做需要匹配撤销版本', { skip: !url }, async () => inSchema(async client => {
  await client.query(`CREATE TABLE mind_nodes (id int PRIMARY KEY,user_id uuid,kind text,title text,content_md text,content_plain text,color text,captured_at timestamptz,deleted_at timestamptz,version int,ref_snapshot json,updated_at timestamptz)`)
  await client.query("INSERT INTO mind_nodes VALUES (3,$1,'note',NULL,'内容','内容',NULL,'2020-01-01Z',NULL,1,NULL,CURRENT_TIMESTAMP)", [owner])
  const snapshot = { id: 3, kind: 'note', title: null, content_md: '内容', content_plain: '内容', color: null, captured_at: '2020-01-01T00:00:00Z', deleted_at: null, version: 1 }
  const operation = { id: 'op-1', action: 'create', before_state: { items: {} }, after_state: { items: { 'note:3': snapshot }, undo_versions: {} as Record<string, unknown> } }
  await client.query('BEGIN')
  const undo = await applyMindUndoCore(client, owner, operation, 'undo')
  assert.equal(undo.versions['note:3'], 2)
  assert.ok((await client.query('SELECT deleted_at FROM mind_nodes WHERE id=3')).rows[0].deleted_at)
  operation.after_state.undo_versions = undo.versions
  const redo = await applyMindUndoCore(client, owner, operation, 'redo')
  assert.equal(redo.versions['note:3'], 3)
  assert.equal((await client.query('SELECT deleted_at FROM mind_nodes WHERE id=3')).rows[0].deleted_at, null)
  await assert.rejects(applyMindUndoCore(client, owner, operation, 'redo'), MindUndoConflict)
  await client.query('ROLLBACK')
}))

test('多资源撤销先检查全部快照，冲突时不写入任何资源', { skip: !url }, async () => inSchema(async client => {
  await client.query('CREATE TABLE mind_maps (id int PRIMARY KEY,user_id uuid,title text,project_id int,data_json text,deleted_at timestamptz,updated_at timestamptz)')
  await client.query("INSERT INTO mind_maps VALUES (1,$1,'原值',NULL,'{}',NULL,CURRENT_TIMESTAMP),(2,$1,'并发修改',NULL,'{}',NULL,CURRENT_TIMESTAMP)", [owner])
  const item = (id: number) => ({ id, title: '原值', project_id: null, data_json: '{}', deleted_at: null })
  await client.query('BEGIN')
  await assert.rejects(applyMindUndoCore(client, owner, { id: 'op', action: 'create', before_state: { items: {} }, after_state: { items: { 'canvas:1': item(1), 'canvas:2': item(2) } } }, 'undo'), MindUndoConflict)
  assert.deepEqual((await client.query('SELECT id,deleted_at FROM mind_maps ORDER BY id')).rows, [{ id: 1, deleted_at: null }, { id: 2, deleted_at: null }])
  await client.query('ROLLBACK')
}))

test('快照中的 JSON 对象按内容比较，等价对象可撤销', { skip: !url }, async () => inSchema(async client => {
  // 旧记录中使用 JSON 对象的兼容行为；正式画布 data_json 常规为文本。
  await client.query('CREATE TABLE mind_maps (id int PRIMARY KEY,user_id uuid,title text,project_id int,data_json jsonb,deleted_at timestamptz,updated_at timestamptz)')
  await client.query("INSERT INTO mind_maps VALUES (1,$1,'画布',NULL,$2::jsonb,NULL,CURRENT_TIMESTAMP)", [owner, JSON.stringify({ view: { x: 1 } })])
  await client.query('BEGIN')
  const snapshot = { id: 1, title: '画布', project_id: null, data_json: { view: { x: 1 } }, deleted_at: null }
  const result = await applyMindUndoCore(client, owner, { id: 'op', action: 'create', before_state: {}, after_state: { items: { 'canvas:1': snapshot } } }, 'undo')
  assert.equal(result.events[0]?.operation, 'delete')
  assert.ok((await client.query('SELECT deleted_at FROM mind_maps WHERE id=1')).rows[0].deleted_at)
  await client.query('ROLLBACK')
}))
