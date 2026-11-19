import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { Pool } from 'pg'
import test from 'node:test'
import { createPostgresFolderCopyOperations } from '../../src/modules/files/folders/copy.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const owner = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'

test('PostgreSQL Local 文件夹复制接通子树、文件字节、目标项目、配额、事件与 owner 隔离', {
  skip: !databaseUrl && '设置 GUGU_WEBUI_TEST_DATABASE_URL 后运行隔离 PostgreSQL 文件夹复制回归',
}, async () => {
  const schema = `gugu_folder_copy_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-folder-copy-'))
  const events: number[] = []
  try {
    await pool.query(`
      CREATE TABLE projects(id serial PRIMARY KEY,user_id uuid,name text,color text,start_date date,created_at timestamptz DEFAULT CURRENT_TIMESTAMP,deleted_at timestamptz);
      CREATE TABLE workspace_directories(id serial PRIMARY KEY,user_id uuid,directory_name text,deleted_at timestamptz);
      CREATE TABLE folders(id serial PRIMARY KEY,user_id uuid,project_id int,workspace_directory_id int,parent_id int,name text,search_romaji text,version int NOT NULL DEFAULT 1,deleted_at timestamptz,created_at timestamptz DEFAULT CURRENT_TIMESTAMP,updated_at timestamptz DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE files(id serial PRIMARY KEY,user_id uuid,display_name text,ext text,space text,project_id int,folder_id int,workspace_directory_id int,stage_name text,
        storage_key text,storage_backend text,size text,size_bytes bigint,mime_type text,img_width int,img_height int,version int DEFAULT 1,created_at timestamptz,updated_at timestamptz,deleted_at timestamptz);
      CREATE TABLE storage_quota_ledgers(user_id uuid,category text,used_bytes bigint,reserved_bytes bigint,limit_bytes bigint,status text,updated_at timestamptz,PRIMARY KEY(user_id,category));
      CREATE TABLE storage_quota_events(user_id uuid,category text,operation text,delta_bytes bigint,resource_type text,resource_id text,idempotency_key text,metadata_json jsonb,created_at timestamptz);
      CREATE TABLE workspaces(id serial PRIMARY KEY,user_id uuid,kind text,folder_id int,project_id int,directory_id int,enabled boolean DEFAULT true);
      INSERT INTO projects(user_id,name,start_date) VALUES('${owner}','目标项目','2026-07-15');
      INSERT INTO folders(user_id,name,search_romaji) VALUES('${owner}','资料',''),('${owner}','子目录','');
      UPDATE folders SET parent_id=1 WHERE id=2;
      INSERT INTO folders(user_id,project_id,name,search_romaji) VALUES('${owner}',1,'资料','');
      INSERT INTO files(user_id,display_name,ext,space,folder_id,storage_key,storage_backend,size,size_bytes,mime_type,created_at,updated_at)
      VALUES('${owner}','根文件','txt','personal',1,'${owner}/个人文件/资料/根文件.txt','local','4 B',4,'text/plain',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
        ('${owner}','子文件','txt','personal',2,'${owner}/个人文件/资料/子目录/子文件.txt','local','5 B',5,'text/plain',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
        ('${other}','私有文件','txt','personal',NULL,'${other}/个人文件/私有文件.txt','local','4 B',4,'text/plain',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
      INSERT INTO storage_quota_ledgers(user_id,category,used_bytes,reserved_bytes,limit_bytes,status)
      VALUES('${owner}','file_library',9,0,1000,'active');
    `)
    for (const [key, body] of [
      [`${owner}/个人文件/资料/根文件.txt`, 'root'],
      [`${owner}/个人文件/资料/子目录/子文件.txt`, 'child'],
      [`${other}/个人文件/私有文件.txt`, 'nope'],
    ]) {
      const location = path.join(root, ...key.split('/'))
      await mkdir(path.dirname(location), { recursive: true })
      await writeFile(location, body)
    }
    const operations = createPostgresFolderCopyOperations(pool, {
      storageRoot: root, fileSyncEnabled: false, buildSearchRomaji: () => '',
      async publishChanged(event) { events.push(Number(event.folder.id)) },
    })
    const copy = await operations.copy(owner, 1, { parentId: null, projectId: 1, workspaceDirectoryId: null }, {
      undoContextId: null, idempotencyKey: null, clientId: 'web',
    }) as { id: number; name: string; projectId: number; fileCount: number; folderCount: number }
    assert.deepEqual(copy, { id: 4, projectId: 1, workspaceDirectoryId: null, parentId: null, name: '资料(1)', fileCount: 1, folderCount: 0, version: 1 })
    assert.equal(await readFile(path.join(root, owner, '项目文件', '2026', '07', '目标项目 #1', '资料(1)', '根文件.txt'), 'utf8'), 'root')
    assert.equal(await readFile(path.join(root, owner, '项目文件', '2026', '07', '目标项目 #1', '资料(1)', '子目录', '子文件.txt'), 'utf8'), 'child')
    const quota = await pool.query<{ used_bytes: number }>('SELECT used_bytes FROM storage_quota_ledgers WHERE user_id=$1', [owner])
    assert.equal(Number(quota.rows[0]!.used_bytes), 18)
    assert.deepEqual(events, [4])
    await assert.rejects(operations.copy(other, 1, { parentId: null, projectId: null, workspaceDirectoryId: null }, {
      undoContextId: null, idempotencyKey: null, clientId: null,
    }), /文件夹不存在/)
    assert.equal(await readFile(path.join(root, other, '个人文件', '私有文件.txt'), 'utf8'), 'nope')
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
    await rm(root, { recursive: true, force: true })
  }
})
