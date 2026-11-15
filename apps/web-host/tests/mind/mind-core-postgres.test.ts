import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { applyMindUndoCore } from '../../src/domains/undo/persistence/mind-core.js'
import { MindUndoConflict, MindUndoUnsupported } from '../../src/domains/undo/persistence/mind.js'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const owner = '11111111-1111-4111-8111-111111111111'
test('借用 PG 连接保留外层事务及错误类型', { skip: !url }, async () => {
  const admin = new Pool({ connectionString: url }), schema = `gugu_mind_bridge_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema} -c timezone=UTC`, max: 2 })
  const client = await pool.connect()
  try {
    await client.query(`CREATE TABLE mind_nodes (id integer PRIMARY KEY,user_id uuid NOT NULL,kind text NOT NULL,title text,content_md text,content_plain text,color text,captured_at timestamptz,deleted_at timestamptz,version int NOT NULL,ref_snapshot json,updated_at timestamptz)`)
    await client.query(`INSERT INTO mind_nodes VALUES (1,$1,'note',NULL,'正文','正文',NULL,'2020-01-01T00:00:00Z',NULL,1,NULL,CURRENT_TIMESTAMP)`, [owner])
    const snapshot = { id: 1, kind: 'note', title: null, content_md: '正文', content_plain: '正文', color: null, captured_at: '2020-01-01T00:00:00.000+00:00', deleted_at: null, version: 1 }
    const operation = { id: 'op-test', action: 'create', before_state: { items: {} }, after_state: { items: { 'note:1': snapshot } } }
    // release 必须由测试自身调用，桥调用 release 会立即失败。
    const borrowed = new Proxy(client, { get(target, prop) { if (prop === 'release') return () => { throw new Error('桥不能释放连接') }; const value = Reflect.get(target, prop, target); return typeof value === 'function' ? value.bind(target) : value } }) as PoolClient
    await client.query('BEGIN')
    const undone = await applyMindUndoCore(borrowed, owner, operation, 'undo')
    assert.equal(undone.versions['note:1'], 2)
    assert.ok((await client.query('SELECT deleted_at FROM mind_nodes WHERE id=1')).rows[0].deleted_at)
    await client.query('ROLLBACK')
    assert.deepEqual((await client.query('SELECT deleted_at,version FROM mind_nodes WHERE id=1')).rows[0], { deleted_at: null, version: 1 })
    await client.query('BEGIN')
    await assert.rejects(applyMindUndoCore(borrowed, owner, { ...operation, after_state: { items: { 'note:1': { ...snapshot, title: '冲突' } } } }, 'undo'), MindUndoConflict)
    await assert.rejects(applyMindUndoCore(borrowed, owner, { ...operation, after_state: { items: { 'unknown:1': snapshot } } }, 'undo'), MindUndoUnsupported)
    assert.equal((await client.query('SELECT 1 AS value')).rows[0].value, 1)
    await applyMindUndoCore(borrowed, owner, operation, 'undo')
    await client.query('COMMIT')
    const result = await client.query('SELECT deleted_at,version FROM mind_nodes WHERE id=1')
    assert.ok(result.rows[0].deleted_at)
    assert.equal(result.rows[0].version, 2)
    assert.equal((await client.query('SELECT 1 AS value')).rows[0].value, 1)
  } finally {
    await client.query('ROLLBACK').catch(() => undefined)
    client.release()
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})
