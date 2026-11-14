import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Pool } from 'pg'
import test from 'node:test'
import { createPostgresFileUploadOperations } from '../../src/domains/files/file-upload-postgres.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const ownerId = '11111111-1111-4111-8111-111111111111'

test('PostgreSQL Local 上传创建文件并覆盖时同步更新物理正文、版本与配额', {
  skip: !databaseUrl && '设置 GUGU_WEBUI_TEST_DATABASE_URL 后运行隔离 PostgreSQL 上传回归',
}, async () => {
  const schema = `gugu_file_upload_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 3 })
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-upload-postgres-'))
  const published: Array<{ operation: string; entityId: number }> = []
  try {
    await pool.query(`
      CREATE TABLE users (id uuid PRIMARY KEY, storage_limit_bytes bigint);
      CREATE TABLE projects (
        id serial PRIMARY KEY, user_id uuid NOT NULL, name varchar(200) NOT NULL, color varchar(300),
        start_date date, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, deleted_at timestamptz
      );
      CREATE TABLE workspace_directories (
        id serial PRIMARY KEY, user_id uuid NOT NULL, directory_name varchar(200) NOT NULL, deleted_at timestamptz
      );
      CREATE TABLE folders (
        id serial PRIMARY KEY, user_id uuid NOT NULL, project_id integer, workspace_directory_id integer,
        parent_id integer, name varchar(255) NOT NULL, deleted_at timestamptz
      );
      CREATE TABLE mind_maps (id serial PRIMARY KEY, user_id uuid NOT NULL, title varchar(300), deleted_at timestamptz);
      CREATE TABLE files (
        id serial PRIMARY KEY, user_id uuid NOT NULL, display_name varchar(300) NOT NULL, ext varchar(20) NOT NULL,
        space varchar(20) NOT NULL, workspace_directory_id integer, project_id integer, folder_id integer,
        stage_name varchar(100) NOT NULL, mind_map_id integer, storage_key varchar(500) NOT NULL,
        storage_backend varchar(20) NOT NULL, version integer NOT NULL, size varchar(50) NOT NULL,
        size_bytes bigint NOT NULL, mime_type varchar(200), img_width integer, img_height integer,
        created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz
      );
      CREATE TABLE storage_quota_ledgers (
        user_id uuid NOT NULL, category varchar(32) NOT NULL, used_bytes bigint NOT NULL,
        reserved_bytes bigint NOT NULL, limit_bytes bigint NOT NULL, status varchar(20) NOT NULL,
        updated_at timestamptz, PRIMARY KEY(user_id,category)
      );
      CREATE TABLE storage_quota_events (
        user_id uuid NOT NULL, category varchar(32) NOT NULL, operation varchar(32) NOT NULL,
        delta_bytes bigint NOT NULL, resource_type varchar(32), resource_id varchar(255),
        idempotency_key varchar(255) NOT NULL, metadata_json jsonb, created_at timestamptz NOT NULL
      );
      INSERT INTO users(id,storage_limit_bytes) VALUES ('${ownerId}',1000);
      INSERT INTO storage_quota_ledgers(user_id,category,used_bytes,reserved_bytes,limit_bytes,status)
      VALUES ('${ownerId}','file_library',0,0,1000,'active');
    `)
    await mkdir(root, { recursive: true })
    const operations = createPostgresFileUploadOperations(pool, {
      storageRoot: root,
      defaultLimitBytes: 1000,
      async publishChanged(event) { published.push({ operation: event.operation, entityId: event.entityId }) },
    })
    const input = {
      space: 'personal', projectId: null, folderId: null, workspaceDirectoryId: null,
      stageName: '', mindMapId: null, onConflict: 'keep_both' as const, overwriteFileId: null,
    }
    const firstPath = path.join(root, 'first-upload')
    await writeFile(firstPath, 'before')
    const created = await operations.store(ownerId, {
      input, originalName: '记录.txt', mimeType: 'text/plain', path: firstPath,
      sizeBytes: 6, sha256: 'unused-in-storage-adapter-test', imgWidth: 4, imgHeight: 7,
    }, { idempotencyKey: null, undoContextId: null, clientId: 'test-client' }) as { id: number; version: number; sizeBytes: number }
    assert.equal(created.version, 1)
    assert.equal(created.sizeBytes, 6)
    assert.equal((await pool.query('SELECT img_width,img_height FROM files WHERE id=$1', [created.id])).rows[0]?.img_width, 4)
    assert.equal((await pool.query('SELECT img_width,img_height FROM files WHERE id=$1', [created.id])).rows[0]?.img_height, 7)
    assert.equal(await readFile(path.join(root, ownerId, '个人文件', '记录.txt'), 'utf8'), 'before')

    const overwritePath = path.join(root, 'overwrite-upload')
    await writeFile(overwritePath, 'after content')
    const overwritten = await operations.store(ownerId, {
      input: { ...input, onConflict: 'overwrite', overwriteFileId: created.id },
      originalName: '记录.txt', mimeType: 'text/plain', path: overwritePath,
      sizeBytes: 13, sha256: 'unused-in-storage-adapter-test', imgWidth: 8, imgHeight: 9,
    }, { idempotencyKey: null, undoContextId: null, clientId: 'test-client' }) as { id: number; version: number; sizeBytes: number }
    assert.equal(overwritten.id, created.id)
    assert.equal(overwritten.version, 2)
    assert.equal(overwritten.sizeBytes, 13)
    const imageDimensions = await pool.query<{ img_width: number; img_height: number }>(
      'SELECT img_width,img_height FROM files WHERE id=$1', [created.id],
    )
    assert.deepEqual(imageDimensions.rows[0], { img_width: 8, img_height: 9 })
    assert.equal(await readFile(path.join(root, ownerId, '个人文件', '记录.txt'), 'utf8'), 'after content')
    const quota = await pool.query<{ used_bytes: string }>(
      `SELECT used_bytes FROM storage_quota_ledgers WHERE user_id=$1 AND category='file_library'`, [ownerId],
    )
    assert.equal(Number(quota.rows[0]!.used_bytes), 13)
    assert.deepEqual(published.map((event) => event.operation), ['create', 'update'])
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
    await rm(root, { recursive: true, force: true })
  }
})
