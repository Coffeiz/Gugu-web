import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { readProjectFileOverview } from '../../src/domains/projects/persistence/projects.js'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL
test('项目概览仅统计当前 owner 的存活项目文件与文件夹', { skip: !url }, async () => {
  const admin = new Pool({ connectionString: url })
  const schema = `gugu_overview_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    await pool.query(`CREATE TABLE files(user_id uuid,project_id integer,space text,folder_id integer,deleted_at timestamptz);
      CREATE TABLE folders(user_id uuid,project_id integer,deleted_at timestamptz)`)
    const owner = randomUUID(), other = randomUUID()
    await pool.query(`INSERT INTO files VALUES
      ($1,1,'project',NULL,NULL),($1,1,'project',10,NULL),($1,1,'project',NULL,now()),
      ($1,1,'personal',NULL,NULL),($1,2,'project',NULL,NULL),($2,1,'project',NULL,NULL)`, [owner, other])
    await pool.query(`INSERT INTO folders VALUES ($1,1,NULL),($1,1,now()),($1,2,NULL),($2,1,NULL)`, [owner, other])
    assert.deepEqual(await readProjectFileOverview(pool, owner, 1), { total_file_count: 2, root_file_count: 1, total_folder_count: 1 })
    assert.deepEqual(await readProjectFileOverview(pool, other, 2), { total_file_count: 0, root_file_count: 0, total_folder_count: 0 })
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})
