import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import { createPostgresFileConflictOperations } from '../../src/domains/files/file-conflicts-postgres.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const owner = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'

test('PostgreSQL 冲突探测按 owner 和完整目标空间查询并保留点文件扩展名规则', {
  skip: !databaseUrl && '设置 GUGU_WEBUI_TEST_DATABASE_URL 后运行隔离 PostgreSQL 文件冲突回归',
}, async () => {
  const schema = `gugu_file_conflicts_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  try {
    await pool.query(`
      CREATE TABLE projects(id integer PRIMARY KEY,user_id uuid,name text,color text);
      CREATE TABLE folders(id integer PRIMARY KEY,user_id uuid,name text);
      CREATE TABLE files(id integer PRIMARY KEY,user_id uuid,display_name text,ext text,space text,
        workspace_directory_id integer,project_id integer,stage_name text,folder_id integer,mind_map_id integer,
        size text,size_bytes bigint,mime_type text,created_at timestamptz,deleted_at timestamptz,
        img_width integer,img_height integer,version integer);
      INSERT INTO projects(id,user_id,name,color) VALUES(4,'${owner}','合成项目','#123456');
      INSERT INTO folders(id,user_id,name) VALUES(8,'${owner}','目标夹');
      INSERT INTO files VALUES
        (1,'${owner}','report','PDF','personal',NULL,NULL,'',NULL,NULL,'10 B',10,'application/pdf',CURRENT_TIMESTAMP,NULL,NULL,NULL,3),
        (2,'${owner}','report','PDF','project',NULL,4,'',8,NULL,'20 B',20,'application/pdf',CURRENT_TIMESTAMP,NULL,NULL,NULL,1),
        (3,'${owner}','.gitconfig','FILE','personal',NULL,NULL,'',NULL,NULL,'2 B',2,'text/plain',CURRENT_TIMESTAMP,NULL,NULL,NULL,1),
        (4,'${other}','report','PDF','personal',NULL,NULL,'',NULL,NULL,'9 B',9,'application/pdf',CURRENT_TIMESTAMP,NULL,NULL,NULL,1);
    `)
    const rows = await createPostgresFileConflictOperations(pool).find(owner, [
      { filename: 'report.pdf', space: 'personal', projectId: null, folderId: null, workspaceDirectoryId: null },
      { filename: 'report.pdf', space: 'project', projectId: 4, folderId: 8, workspaceDirectoryId: null },
      { filename: '.gitconfig', space: 'personal', projectId: null, folderId: null, workspaceDirectoryId: null },
      { filename: 'absent.pdf', space: 'personal', projectId: null, folderId: null, workspaceDirectoryId: null },
    ]) as Array<{ filename: string; conflict: boolean; existing_file: { id: number; ext: string } | null }>
    assert.deepEqual(rows.map((row) => row.conflict), [true, true, true, false])
    assert.deepEqual(rows.map((row) => row.existing_file?.id ?? null), [1, 2, 3, null])
    assert.equal(rows[2]?.existing_file?.ext, 'FILE')
    assert.equal((rows[0]?.existing_file as unknown as Record<string, unknown>).display_name, 'report')
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})
