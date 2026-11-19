import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { checkDatabaseReadiness } from '../../src/database.js'
import { applyAgentBaseMigration } from '@gugu/database/postgres/migrations/0001_initialize'
import { applyWebDomainMigration, checkWebDomainMigration } from '@gugu/database/postgres/migrations/0002_web_domain'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('空库的 Node 业务迁移支持就绪检查、所有权约束和事务内项目文件投影', {
  skip: !url && '需要隔离 PostgreSQL',
}, async () => {
  const schema = `domain_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url })
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await assert.rejects(applyWebDomainMigration(pool), { code: 'incompatible' })
    await applyAgentBaseMigration(pool)
    await assert.rejects(checkDatabaseReadiness(statement => pool.query(statement)), { code: '42P01' })
    assert.equal(await checkWebDomainMigration(pool), 'pending')
    assert.deepEqual((await Promise.all([applyWebDomainMigration(pool), applyWebDomainMigration(pool)])).sort(),
      ['applied', 'unchanged'])
    assert.equal(await checkWebDomainMigration(pool), 'applied')
    await checkDatabaseReadiness(statement => pool.query(statement))

    const owner = randomUUID(), other = randomUUID()
    await pool.query(`INSERT INTO users(id,username,email,hashed_password)
      VALUES($1,'小北','north@example.test','synthetic'),($2,'小南','south@example.test','synthetic')`, [owner, other])
    await pool.query(`INSERT INTO projects(user_id,name,status,color,progress,stages_json,version,archived,created_at,updated_at)
      VALUES($1,'项目甲','active','',0,'[]',1,false,now(),now()),($1,'项目乙','active','',0,'[]',1,false,now(),now())`, [owner])
    await pool.query("INSERT INTO folders(user_id,name,project_id) VALUES($1,'子目录',1)", [owner])
    await assert.rejects(pool.query(`INSERT INTO files(user_id,display_name,ext,space,project_id,storage_key)
      VALUES($1,'异主','txt','project',1,'foreign')`, [other]), { code: '23503' })
    await pool.query(`INSERT INTO files(user_id,display_name,ext,space,project_id,storage_key,folder_id)
      VALUES ($1,'根甲','txt','project',1,'a',NULL),($1,'根乙','txt','project',1,'b',NULL),
             ($1,'子目录文件','txt','project',1,'c',1)`, [owner])
    const counts = async () => (await pool.query('SELECT project_id,file_count::integer FROM project_file_counts ORDER BY project_id')).rows
    assert.deepEqual(await counts(), [{ project_id: 1, file_count: 2 }])
    await pool.query("UPDATE files SET project_id=2 WHERE storage_key='a'")
    assert.deepEqual(await counts(), [{ project_id: 1, file_count: 1 }, { project_id: 2, file_count: 1 }])

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("UPDATE files SET deleted_at=now() WHERE storage_key='b'")
      assert.equal((await client.query('SELECT 1 FROM project_file_counts WHERE project_id=1')).rowCount, 0)
      assert.deepEqual(await counts(), [{ project_id: 1, file_count: 1 }, { project_id: 2, file_count: 1 }])
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
    await pool.query("DELETE FROM files WHERE storage_key='a'")
    assert.deepEqual(await counts(), [{ project_id: 1, file_count: 1 }])
    await pool.query('DELETE FROM projects WHERE id=1')
    assert.deepEqual(await counts(), [])

    await pool.query('ALTER TABLE files DISABLE TRIGGER gugu_project_file_count_insert')
    await assert.rejects(checkWebDomainMigration(pool), { code: 'incompatible' })
  } finally {
    await pool.end()
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) }
    finally { await admin.end() }
  }
})
