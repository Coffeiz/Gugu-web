import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import { createPostgresFileReadOperations } from '../../src/domains/files/file-reads-postgres.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const owner = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'

test('PostgreSQL 相对路径解析限制在来源文件 scope 与 owner，并处理父级/URL 编码', {
  skip: !databaseUrl && '设置 GUGU_WEBUI_TEST_DATABASE_URL 后运行隔离 PostgreSQL 相对路径回归',
}, async () => {
  const schema = `gugu_file_resolve_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  try {
    await pool.query(`
      CREATE TABLE projects(id integer PRIMARY KEY,user_id uuid,name text,color text);
      CREATE TABLE folders(id integer PRIMARY KEY,user_id uuid,project_id integer,workspace_directory_id integer,
        parent_id integer,name text,version integer,deleted_at timestamptz);
      CREATE TABLE files(id integer PRIMARY KEY,user_id uuid,display_name text,ext text,space text,
        workspace_directory_id integer,project_id integer,stage_name text,folder_id integer,mind_map_id integer,
        storage_key text,size text,size_bytes bigint,mime_type text,created_at timestamptz,deleted_at timestamptz,
        img_width integer,img_height integer,version integer);
      INSERT INTO folders VALUES
        (1,'${owner}',NULL,NULL,NULL,'资料',1,NULL),
        (2,'${owner}',NULL,NULL,1,'笔记',2,NULL),
        (3,'${owner}',NULL,NULL,2,'图片',1,NULL),
        (4,'${other}',NULL,NULL,NULL,'外部',1,NULL);
      INSERT INTO files VALUES
        (10,'${owner}','source','MD','personal',NULL,NULL,'',2,NULL,'${owner}/source.md','1 B',1,'text/markdown',CURRENT_TIMESTAMP,NULL,NULL,NULL,1),
        (11,'${owner}','index','MD','personal',NULL,NULL,'',1,NULL,'${owner}/index.md','1 B',1,'text/markdown',CURRENT_TIMESTAMP,NULL,NULL,NULL,1),
        (12,'${owner}','diagram','SVG','personal',NULL,NULL,'',3,NULL,'${owner}/diagram.svg','1 B',1,'image/svg+xml',CURRENT_TIMESTAMP,NULL,NULL,NULL,1),
        (13,'${other}','secret','txt','personal',NULL,NULL,'',4,NULL,'${other}/secret.txt','1 B',1,'text/plain',CURRENT_TIMESTAMP,NULL,NULL,NULL,1);
    `)
    const operations = createPostgresFileReadOperations(pool)
    const result = await operations.resolveRelativePaths!(owner, 10, [
      '../index.md', '%E5%9B%BE%E7%89%87%2Fdiagram.svg?download=1', '../../secret.txt', 'https://example.invalid/index.md',
    ]) as Array<{ path: string; file: { id: number } | null; folder: unknown | null }>
    assert.deepEqual(result.map((item) => item.file?.id ?? null), [11, 12, null, null])
    assert.equal(result[1]?.path, '%E5%9B%BE%E7%89%87%2Fdiagram.svg?download=1')
    const missingSource = await operations.resolveRelativePaths!(other, 10, ['secret.txt'])
    assert.equal(missingSource, null)
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})
