import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { createPostgresFileReadOperations } from '../../../src/modules/files/browse.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const owner = '11111111-1111-4111-8111-111111111111'
test('无旧文件夹表和字段时详情与路径定位可用', { skip: !databaseUrl && '需要隔离 PostgreSQL' }, async () => {
  const schema = `gugu_no_folder_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` })
  try {
    await pool.query(`CREATE TABLE projects(id int, user_id uuid, name text, color text);
      CREATE TABLE files(user_id uuid, display_name text, ext text, space text, workspace_directory_id int,
        path text, project_id int, stage_name text, mind_map_id int, size text, size_bytes bigint,
        mime_type text, created_at timestamptz, deleted_at timestamptz, img_width int, img_height int, version int);
      INSERT INTO files VALUES('${owner}','说明','md','personal',NULL,'${owner}/个人文件/目录/说明.md',NULL,'',NULL,'1 B',1,'text/markdown',now(),NULL,NULL,NULL,1)`)
    const operations = createPostgresFileReadOperations(pool)
    const key = `${owner}/个人文件/目录/说明.md`
    const detail = await operations.getFile(owner, key) as { displayName: string }
    assert.equal(detail.displayName, '说明')
    const location = await operations.getFileLocation(owner, key) as { pathFile: unknown }
    assert.deepEqual(location.pathFile, { directoryId: 'personal', relativePath: '目录/说明.md' })
    assert.equal(await operations.getFile('22222222-2222-4222-8222-222222222222', key), null)
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})
