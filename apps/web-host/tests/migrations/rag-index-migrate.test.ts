import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { tablesSql } from '@gugu/core/data'
import { applyRagIndexMigration, checkRagIndexMigration } from '@gugu/database/postgres/migrations/0011_rag_index'

test('隔离 PostgreSQL：空库迁移、重复执行与结构损坏拒绝', { skip: !process.env.GUGU_WEBUI_TEST_DATABASE_URL && '需要隔离 PostgreSQL' }, async () => {
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
  await pool.query('DROP INDEX ix_knowledge_index_owner_source_indexed')
  await assert.rejects(checkRagIndexMigration(pool),{code:'incompatible'})
  await pool.query(tablesSql('postgres').ragIndexIndexes.find(statement=>statement.includes('ix_knowledge_index_owner_source_indexed'))!)
  await pool.query('ALTER TABLE knowledge_index_entries DROP CONSTRAINT uq_knowledge_index_entry_chunk')
  await assert.rejects(checkRagIndexMigration(pool),{code:'incompatible'})
  await assert.rejects(applyRagIndexMigration(pool),{code:'incompatible'})
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM gugu_schema_migrations`)).rows[0]?.n,1)
 }finally{
  await pool.end()
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
  await admin.end()
 }
})

test('隔离 PostgreSQL：拒绝未登记的同名索引表并保留原数据', { skip: !process.env.GUGU_WEBUI_TEST_DATABASE_URL && '需要隔离 PostgreSQL' }, async()=>{
 const schema=`rag_legacy_${randomUUID().replaceAll('-','')}`
 const admin=new Pool({connectionString:process.env.GUGU_WEBUI_TEST_DATABASE_URL,max:1})
 await admin.query(`CREATE SCHEMA "${schema}"`)
 const pool=new Pool({connectionString:process.env.GUGU_WEBUI_TEST_DATABASE_URL,options:`-c search_path=${schema}`,max:2})
 try{
  await pool.query('CREATE TABLE users(id uuid PRIMARY KEY)')
  await pool.query(tablesSql('postgres').ragIndexEntries)
  await pool.query('ALTER TABLE knowledge_index_entries ADD CONSTRAINT legacy_owner_fk FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE CASCADE')
  await pool.query(tablesSql('postgres').ragIndexIndexes.join(';'))
  await pool.query('DROP INDEX ix_knowledge_index_owner_source_indexed')
  await pool.query("INSERT INTO users VALUES('00000000-0000-4000-8000-000000000002')")
  await pool.query(`INSERT INTO knowledge_index_entries(owner_user_id,source_type,source_id,document_id,document_version,content_hash,metadata_json) VALUES('00000000-0000-4000-8000-000000000002','note','42','note:42','legacy-v1','legacy-hash','{}')`)
  await assert.rejects(applyRagIndexMigration(pool), { code: 'incompatible' })
  await assert.rejects(checkRagIndexMigration(pool), { code: 'incompatible' })
  assert.equal((await pool.query("SELECT 1 FROM pg_indexes WHERE schemaname=current_schema() AND indexname='ix_knowledge_index_owner_source_indexed'")).rows.length,0)
  assert.equal((await pool.query("SELECT to_regclass('gugu_schema_migrations') AS ledger")).rows[0].ledger, null)
  assert.equal((await pool.query('SELECT content_hash FROM knowledge_index_entries')).rows[0]?.content_hash,'legacy-hash')
  await pool.query('ALTER TABLE knowledge_index_entries DROP CONSTRAINT uq_knowledge_index_entry_chunk')
  await assert.rejects(checkRagIndexMigration(pool),{code:'incompatible'})
 }finally{
  await pool.end()
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
  await admin.end()
 }
})
