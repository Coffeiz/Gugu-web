import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Pool, type Pool as PoolType, type PoolClient } from 'pg'
import test from 'node:test'
import { createPostgresFileRestoreOperations } from '../../src/domains/files/file-restore-postgres.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const ownerId = '11111111-1111-4111-8111-111111111111'

test('Local 批量恢复先检查整批归属，再一次提交并逐项发布恢复事件', async () => {
  const root = path.join(tmpdir(), `gugu-file-restore-batch-${randomUUID()}`)
  const source = path.join(root, ownerId, 'trash', 'note.md')
  const target = path.join(root, ownerId, '个人文件', 'note.md')
  await mkdir(path.dirname(source), { recursive: true })
  await writeFile(source, '合成恢复正文')
  const file = {
    id: 1, user_id: ownerId, display_name: 'note', ext: 'md', space: 'personal',
    project_id: null, folder_id: null, workspace_directory_id: null, stage_name: '',
    mind_map_id: null, storage_key: `${ownerId}/trash/note.md`, version: 2,
    size: '6 B', size_bytes: 6, mime_type: 'text/markdown', img_width: null, img_height: null,
    created_at: new Date('2026-11-01T00:00:00Z'), updated_at: new Date('2026-11-01T00:00:00Z'),
    deleted_at: new Date('2026-11-02T00:00:00Z'),
  }
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const client = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values })
      if (sql.includes('SELECT * FROM files')) return { rows: [file], rowCount: 1 }
      if (sql.includes('UPDATE files')) return { rows: [{ id: 1 }], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    },
    release() {},
  }
  const events: number[] = []
  try {
    const operations = createPostgresFileRestoreOperations({
      connect: async () => client,
    } as unknown as PoolType, {
      storageRoot: root,
      async publishChanged(event) {
        assert.equal(calls.at(-1)?.sql, 'COMMIT')
        events.push(event.entityId)
      },
    })
    await operations.restoreBatch!(ownerId, [1, 999], 'synthetic-client')
    assert.deepEqual(calls[1]?.values?.[0], [1, 999])
    assert.equal(await readFile(target, 'utf8'), '合成恢复正文')
    await assert.rejects(readFile(source), { code: 'ENOENT' })
    assert.deepEqual(events, [1])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('PostgreSQL Local 恢复校验父文件夹、处理重名并只在提交后发布事件', {
  skip: !databaseUrl && '设置 GUGU_WEBUI_TEST_DATABASE_URL 后运行隔离 PostgreSQL 文件恢复回归',
}, async () => {
  const schema = `gugu_file_restore_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  const root = path.join(tmpdir(), `gugu-file-restore-${randomUUID()}`)
  const events: number[] = []
  try {
    await pool.query(`
      CREATE TABLE files (
        id serial PRIMARY KEY, user_id uuid NOT NULL, display_name text NOT NULL, ext text NOT NULL,
        space text NOT NULL, project_id integer, folder_id integer, workspace_directory_id integer,
        stage_name text NOT NULL, mind_map_id integer, storage_key text NOT NULL, version integer NOT NULL,
        size text NOT NULL, size_bytes bigint NOT NULL, mime_type text, img_width integer, img_height integer,
        created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz
      );
      CREATE TABLE folders (
        id integer PRIMARY KEY, user_id uuid NOT NULL, name text NOT NULL, parent_id integer,
        project_id integer, workspace_directory_id integer, deleted_at timestamptz
      );
      CREATE TABLE projects (id integer PRIMARY KEY, user_id uuid NOT NULL, name text, start_date date, created_at timestamptz);
      CREATE TABLE workspace_directories (id integer PRIMARY KEY, user_id uuid NOT NULL, directory_name text, deleted_at timestamptz);
      CREATE TABLE mind_maps (id integer PRIMARY KEY, user_id uuid NOT NULL, title text);
      INSERT INTO folders (id,user_id,name,parent_id,project_id,workspace_directory_id,deleted_at)
        VALUES (10,'${ownerId}','资料',NULL,NULL,NULL,CURRENT_TIMESTAMP);
      INSERT INTO files (user_id,display_name,ext,space,folder_id,stage_name,storage_key,version,size,size_bytes,
        mime_type,created_at,updated_at,deleted_at) VALUES
        ('${ownerId}','笔记','md','personal',10,'','${ownerId}/trash/资料/笔记.md',6,'6 B',6,
         'text/markdown',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
    `)
    const source = path.join(root, ownerId, 'trash', '资料', '笔记.md')
    const occupied = path.join(root, ownerId, '个人文件', '资料', '笔记.md')
    await mkdir(path.dirname(source), { recursive: true })
    await mkdir(path.dirname(occupied), { recursive: true })
    await writeFile(source, '待恢复正文')
    await writeFile(occupied, '已有正文')
    const operations = createPostgresFileRestoreOperations(pool, {
      storageRoot: root,
      async publishChanged(event) {
        const committed = await pool.query<{ deleted_at: Date | null }>(
          'SELECT deleted_at FROM files WHERE id=$1 AND user_id=$2', [event.entityId, ownerId],
        )
        assert.equal(committed.rows[0]?.deleted_at, null)
        events.push(event.entityId)
      },
    })

    await assert.rejects(operations.restore(ownerId, 1), (error: unknown) =>
      error instanceof Error && error.message.includes('先恢复文件夹'))
    assert.equal(await readFile(source, 'utf8'), '待恢复正文')
    await pool.query('UPDATE folders SET deleted_at=NULL WHERE id=10')

    await operations.restore(ownerId, 1)

    const file = await pool.query<{ storage_key: string; display_name: string; version: number; deleted_at: Date | null }>(
      'SELECT storage_key,display_name,version,deleted_at FROM files WHERE id=1 AND user_id=$1', [ownerId],
    )
    assert.equal(file.rows[0]?.storage_key, `${ownerId}/个人文件/资料/笔记(1).md`)
    assert.equal(file.rows[0]?.display_name, '笔记(1)')
    assert.equal(file.rows[0]?.version, 6)
    assert.equal(file.rows[0]?.deleted_at, null)
    assert.equal(await readFile(path.join(root, ownerId, '个人文件', '资料', '笔记(1).md'), 'utf8'), '待恢复正文')
    assert.equal(await readFile(occupied, 'utf8'), '已有正文')
    await assert.rejects(readFile(source), { code: 'ENOENT' })
    assert.deepEqual(events, [1])
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
    await rm(root, { recursive: true, force: true })
  }
})

test('PostgreSQL Local 恢复顶层回收站文件夹时按本次墓碑时间恢复子树并还原正文', {
  skip: !databaseUrl && '设置 GUGU_WEBUI_TEST_DATABASE_URL 后运行隔离 PostgreSQL 文件夹恢复回归',
}, async () => {
  const schema = `gugu_trash_folder_restore_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  const root = path.join(tmpdir(), `gugu-trash-folder-restore-${randomUUID()}`)
  const events: Array<{ id: number; type?: string }> = []
  try {
    await pool.query(`
      CREATE TABLE files (
        id serial PRIMARY KEY, user_id uuid NOT NULL, display_name text NOT NULL, ext text NOT NULL,
        space text NOT NULL, project_id integer, folder_id integer, workspace_directory_id integer,
        stage_name text NOT NULL, mind_map_id integer, storage_key text NOT NULL, version integer NOT NULL,
        size text NOT NULL, size_bytes bigint NOT NULL, mime_type text, img_width integer, img_height integer,
        created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz
      );
      CREATE TABLE folders (
        id integer PRIMARY KEY, user_id uuid NOT NULL, name text NOT NULL, parent_id integer,
        project_id integer, workspace_directory_id integer, deleted_at timestamptz, version integer NOT NULL DEFAULT 1,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE projects (id integer PRIMARY KEY, user_id uuid NOT NULL, name text, start_date date, created_at timestamptz);
      CREATE TABLE workspace_directories (id integer PRIMARY KEY, user_id uuid NOT NULL, directory_name text, deleted_at timestamptz);
      CREATE TABLE mind_maps (id integer PRIMARY KEY, user_id uuid NOT NULL, title text);
      INSERT INTO folders (id,user_id,name,parent_id,deleted_at,version)
        VALUES (20,'${ownerId}','资料',NULL,'2026-10-02T00:00:00.123456+00:00',4),
               (21,'${ownerId}','子',20,'2026-10-02T00:00:00.123456+00:00',2),
               (99,'${ownerId}','资料',NULL,NULL,1);
      INSERT INTO files (user_id,display_name,ext,space,folder_id,stage_name,storage_key,version,size,size_bytes,
        mime_type,created_at,updated_at,deleted_at) VALUES
        ('${ownerId}','笔记','md','personal',21,'','${ownerId}/trash/资料/子/笔记.md',6,'6 B',6,
         'text/markdown',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,'2026-10-02T00:00:00.123456+00:00');
    `)
    const source = path.join(root, ownerId, 'trash', '资料', '子', '笔记.md')
    await mkdir(path.dirname(source), { recursive: true })
    await writeFile(source, '回收站正文')
    const operations = createPostgresFileRestoreOperations(pool, {
      storageRoot: root,
      async publishChanged(event) { events.push({ id: event.entityId, type: event.entityType }) },
    })

    const restored = await operations.restoreFolder!(ownerId, 20, 'synthetic-client') as {
      id: number; name: string; version: number
    }
    assert.deepEqual(restored, { id: 20, project_id: null, workspace_directory_id: null, parent_id: null,
      name: '资料(1)', file_count: 0, folder_count: 0, version: 5 })
    const folders = await pool.query<{ id: number; name: string; deleted_at: Date | null }>(
      'SELECT id,name,deleted_at FROM folders WHERE id IN (20,21) ORDER BY id',
    )
    assert.deepEqual(folders.rows.map((folder) => [folder.name, folder.deleted_at]), [['资料(1)', null], ['子', null]])
    const file = await pool.query<{ storage_key: string; deleted_at: Date | null }>(
      'SELECT storage_key,deleted_at FROM files WHERE id=1',
    )
    assert.equal(file.rows[0]?.storage_key, `${ownerId}/个人文件/资料(1)/子/笔记.md`)
    assert.equal(file.rows[0]?.deleted_at, null)
    assert.equal(await readFile(path.join(root, ownerId, '个人文件', '资料(1)', '子', '笔记.md'), 'utf8'), '回收站正文')
    assert.deepEqual(events, [{ id: 1, type: 'file' }, { id: 20, type: 'folder' }])
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
    await rm(root, { recursive: true, force: true })
  }
})
