import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { Pool } from 'pg'
import test from 'node:test'
import { createPostgresFileArchiveOperations } from '../../src/domains/files/file-archive-postgres.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const ownerId = '11111111-1111-4111-8111-111111111111'
const otherOwnerId = '22222222-2222-4222-8222-222222222222'

test('PostgreSQL Local 归档保留选中文件夹树并可解压回原空间', {
  skip: !databaseUrl && '需要隔离 PostgreSQL：设置 GUGU_WEBUI_TEST_DATABASE_URL',
}, async () => {
  const schema = `gugu_file_archive_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 3 })
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'gugu-file-archive-'))
  const publishedFiles: number[] = []
  const publishedBatches: string[] = []
  try {
    await pool.query(`
      CREATE TABLE users(id uuid PRIMARY KEY,storage_limit_bytes bigint);
      CREATE TABLE projects(id integer PRIMARY KEY,user_id uuid,name text,color text,start_date date,created_at timestamptz,deleted_at timestamptz);
      CREATE TABLE workspace_directories(id integer PRIMARY KEY,user_id uuid,directory_name text,deleted_at timestamptz);
      CREATE TABLE folders(id serial PRIMARY KEY,user_id uuid NOT NULL,parent_id integer,name text NOT NULL,
        project_id integer,workspace_directory_id integer,deleted_at timestamptz);
      CREATE TABLE files(id serial PRIMARY KEY,user_id uuid NOT NULL,display_name text NOT NULL,ext text NOT NULL,
        space text NOT NULL,project_id integer,folder_id integer,workspace_directory_id integer,stage_name text NOT NULL,
        mind_map_id integer,storage_key text NOT NULL,storage_backend text NOT NULL,version integer NOT NULL,
        size text NOT NULL,size_bytes bigint NOT NULL,mime_type text,img_width integer,img_height integer,
        created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,deleted_at timestamptz);
      CREATE TABLE storage_quota_ledgers(user_id uuid,category text,used_bytes bigint,reserved_bytes bigint,
        limit_bytes bigint,status text,updated_at timestamptz,PRIMARY KEY(user_id,category));
      CREATE TABLE storage_quota_events(user_id uuid,category text,operation text,delta_bytes bigint,
        resource_type text,resource_id text,idempotency_key text,metadata_json jsonb,created_at timestamptz);
      INSERT INTO users VALUES ('${ownerId}',10000000),('${otherOwnerId}',10000000);
      INSERT INTO storage_quota_ledgers VALUES ('${ownerId}','file_library',4,0,10000000,'active',CURRENT_TIMESTAMP);
      INSERT INTO folders(id,user_id,parent_id,name,project_id,workspace_directory_id,deleted_at) VALUES
        (10,'${ownerId}',NULL,'资料',NULL,NULL,NULL),(11,'${ownerId}',10,'子目录',NULL,NULL,NULL),
        (12,'${otherOwnerId}',NULL,'他人目录',NULL,NULL,NULL);
      INSERT INTO files(user_id,display_name,ext,space,project_id,folder_id,workspace_directory_id,
        stage_name,mind_map_id,storage_key,storage_backend,version,size,size_bytes,mime_type,img_width,img_height,
        created_at,updated_at,deleted_at) VALUES
        ('${ownerId}','笔记','txt','personal',NULL,11,NULL,'',NULL,'${ownerId}/个人文件/资料/子目录/笔记.txt','local',1,'4 B',4,
          'text/plain',NULL,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,NULL),
        ('${otherOwnerId}','私有','txt','personal',NULL,12,NULL,'',NULL,'${otherOwnerId}/个人文件/他人目录/私有.txt','local',1,'6 B',6,
          'text/plain',NULL,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,NULL);
    `)
    const sourcePath = path.join(storageRoot, ownerId, '个人文件', '资料', '子目录', '笔记.txt')
    await mkdir(path.dirname(sourcePath), { recursive: true })
    await writeFile(sourcePath, '正文')
    const foreignPath = path.join(storageRoot, otherOwnerId, '个人文件', '他人目录', '私有.txt')
    await mkdir(path.dirname(foreignPath), { recursive: true })
    await writeFile(foreignPath, '不得读取')

    const operations = createPostgresFileArchiveOperations(pool, {
      storageRoot,
      fileSyncEnabled: false,
      defaultLimitBytes: 10000000,
      async publishCreatedFile(event) { publishedFiles.push(event.entityId) },
      async publishCreatedBatch(owner, origin) { publishedBatches.push(`${owner}:${origin ?? ''}`) },
    })
    const metadata = { idempotencyKey: null, undoContextId: null, clientId: 'archive-test' }
    const archived = await operations.archive(ownerId, { fileIds: [], folderIds: [10] }, metadata) as {
      id: number; displayName: string; ext: string; folderId: number | null; sizeBytes: number
    }
    assert.equal(archived.displayName, '资料')
    assert.equal(archived.ext, 'zip')
    assert.equal(archived.folderId, null)
    assert.deepEqual(publishedFiles, [archived.id])

    const archiveRow = await pool.query<{ storage_key: string }>('SELECT storage_key FROM files WHERE id=$1', [archived.id])
    const archiveBytes = await readFile(path.join(storageRoot, archiveRow.rows[0]!.storage_key))
    const zip = await JSZip.loadAsync(archiveBytes)
    assert.deepEqual(Object.keys(zip.files).sort(), ['资料/', '资料/子目录/', '资料/子目录/笔记.txt'])
    assert.equal(await zip.file('资料/子目录/笔记.txt')!.async('string'), '正文')
    assert.equal(zip.file('资料/子目录/私有.txt'), null)

    const extracted = await operations.unarchive(ownerId, { fileId: archived.id }, metadata) as {
      created_count: number; file_count: number; folder_count: number; skipped_count: number;
      file_ids: number[]; folder_ids: number[]
    }
    assert.deepEqual({
      created_count: extracted.created_count, file_count: extracted.file_count,
      folder_count: extracted.folder_count, skipped_count: extracted.skipped_count,
    }, { created_count: 3, file_count: 1, folder_count: 2, skipped_count: 0 })
    assert.equal(extracted.file_ids.length, 1)
    assert.equal(extracted.folder_ids.length, 2)
    const extractedRow = await pool.query<{ storage_key: string; size_bytes: number | string }>(
      'SELECT storage_key,size_bytes FROM files WHERE id=$1 AND user_id=$2', [extracted.file_ids[0], ownerId])
    assert.equal(Number(extractedRow.rows[0]!.size_bytes), 6)
    assert.equal(await readFile(path.join(storageRoot, extractedRow.rows[0]!.storage_key), 'utf8'), '正文')
    assert.deepEqual(publishedBatches, [`${ownerId}:archive-test`])
    const quota = await pool.query<{ used_bytes: number | string; operations: string[] }>(
      `SELECT ledger.used_bytes,ARRAY(SELECT operation FROM storage_quota_events WHERE user_id=ledger.user_id ORDER BY operation) operations
       FROM storage_quota_ledgers ledger WHERE user_id=$1 AND category='file_library'`, [ownerId])
    assert.equal(Number(quota.rows[0]!.used_bytes),
      4 + archived.sizeBytes + Number(extractedRow.rows[0]!.size_bytes))
    assert.deepEqual(quota.rows[0]!.operations, ['archive_compress', 'archive_extract'])
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
    await rm(storageRoot, { recursive: true, force: true })
  }
})
