import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { createStorageLiveTotals } from '../../../src/modules/admin/storage.js'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL
test('实时存储统计分离草稿和已挂载附件，统计全部文件且不写快照', { skip: !url && '需要隔离PG' }, async () => {
  const schema = `storage_totals_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    await pool.query('CREATE TABLE files(id serial PRIMARY KEY,size_bytes bigint NOT NULL,is_deleted boolean NOT NULL)')
    await pool.query('CREATE TABLE chat_attachments(id serial PRIMARY KEY,state text NOT NULL,size bigint NOT NULL)')
    await pool.query('CREATE TABLE storage_category_snapshots(id serial PRIMARY KEY)')
    const read = createStorageLiveTotals((sql, params) => pool.query(sql, params))
    assert.deepEqual(await read(), { categories: { chat_staging_draft: { object_count: 0, total_bytes: 0 }, chat_staging_attached: { object_count: 0, total_bytes: 0 }, user_files: { object_count: 0, total_bytes: 0 } } })
    await pool.query('INSERT INTO files(size_bytes,is_deleted) VALUES (100,false),(200,true)')
    await pool.query("INSERT INTO chat_attachments(state,size) VALUES ('draft',50),('attached',100),('deleted',9999)")
    assert.deepEqual(await read(), { categories: { chat_staging_draft: { object_count: 1, total_bytes: 50 }, chat_staging_attached: { object_count: 1, total_bytes: 100 }, user_files: { object_count: 2, total_bytes: 300 } } })
    assert.deepEqual((await pool.query('SELECT * FROM storage_category_snapshots')).rows, [])
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
