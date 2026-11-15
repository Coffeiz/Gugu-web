import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { tablesSql } from '@gugu/core/data'
import { applyRagIndexMigration, checkRagIndexMigration } from '../../src/migrations/rag-index-migrate.js'

test('隔离 PostgreSQL：空库迁移、旧 Python 表认领、重复执行与结构损坏拒绝', { skip: !process.env.GUGU_WEBUI_TEST_DATABASE_URL && '需要隔离 PostgreSQL' }, async () => {
 const schema=`rag_migrate_${randomUUID().replaceAll('-','')}`
 const admin=new Pool({connectionString:process.env.GUGU_WEBUI_TEST_DATABASE_URL,max:1})
 await admin.query(`CREATE SCHEMA "${schema}"`)
 const pool=new Pool({connectionString:process.env.GUGU_WEBUI_TEST_DATABASE_URL,options:`-c search_path=${schema}`,max:4})
 try{
  await pool.query('CREATE TABLE users(id uuid PRIMARY KEY)')
  assert.equal(await checkRagIndexMigration(pool),'pending')
  assert.equal(await applyRagIndexMigration(pool),'applied')
  assert.equal(await checkRagIndexMigration(pool),'applied')
  assert.equal(await applyRagIndexMigration(pool),'unchanged')
  await pool.query("INSERT INTO users VALUES('00000000-0000-4000-8000-000000000001')")
  await pool.query(`INSERT INTO knowledge_index_entries(owner_user_id,source_type,source_id,document_id,document_version,content_hash,metadata_json) VALUES('00000000-0000-4000-8000-000000000001','note','7','note:7','v1','hash','{}')`)
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM knowledge_index_entries')).rows[0]?.n,1)
  await pool.query('ALTER TABLE knowledge_index_entries DROP CONSTRAINT uq_knowledge_index_entry_chunk')
  await assert.rejects(checkRagIndexMigration(pool),{code:'incompatible'})
  await assert.rejects(applyRagIndexMigration(pool),{code:'incompatible'})
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM gugu_node_rag_migrations`)).rows[0]?.n,1)
 }finally{
  await pool.end()
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
  await admin.end()
 }
})

test('隔离 PostgreSQL：无损认领旧版兼容表并拒绝缺少唯一约束的表', { skip: !process.env.GUGU_WEBUI_TEST_DATABASE_URL && '需要隔离 PostgreSQL' }, async()=>{
 const schema=`rag_legacy_${randomUUID().replaceAll('-','')}`
 const admin=new Pool({connectionString:process.env.GUGU_WEBUI_TEST_DATABASE_URL,max:1})
 await admin.query(`CREATE SCHEMA "${schema}"`)
 const pool=new Pool({connectionString:process.env.GUGU_WEBUI_TEST_DATABASE_URL,options:`-c search_path=${schema}`,max:2})
 try{
  await pool.query('CREATE TABLE users(id uuid PRIMARY KEY)')
  await pool.query(tablesSql('postgres').ragIndexEntries)
  await pool.query('ALTER TABLE knowledge_index_entries ADD CONSTRAINT legacy_owner_fk FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE CASCADE')
  await pool.query(tablesSql('postgres').ragIndexIndexes.join(';'))
  await pool.query("INSERT INTO users VALUES('00000000-0000-4000-8000-000000000002')")
  await pool.query(`INSERT INTO knowledge_index_entries(owner_user_id,source_type,source_id,document_id,document_version,content_hash,metadata_json) VALUES('00000000-0000-4000-8000-000000000002','note','42','note:42','legacy-v1','legacy-hash','{}')`)
  assert.equal(await applyRagIndexMigration(pool),'applied')
  assert.equal(await checkRagIndexMigration(pool),'applied')
  assert.equal((await pool.query('SELECT content_hash FROM knowledge_index_entries')).rows[0]?.content_hash,'legacy-hash')
  await pool.query('ALTER TABLE knowledge_index_entries DROP CONSTRAINT uq_knowledge_index_entry_chunk')
  await assert.rejects(checkRagIndexMigration(pool),{code:'incompatible'})
 }finally{
  await pool.end()
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
  await admin.end()
 }
})
