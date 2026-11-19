import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Pool, type QueryResultRow } from 'pg'
import { createPostgresFolderDeleteOperations } from '../../src/modules/files/folders/delete.js'

const ownerId = '11111111-1111-4111-8111-111111111111'
const foreignOwnerId = '22222222-2222-4222-8222-222222222222'

function fixture() {
  const folders = [
    { id: 10, user_id: ownerId, parent_id: null, project_id: null, workspace_directory_id: null,
      name: '资料', version: 2, deleted_at: null },
    { id: 11, user_id: ownerId, parent_id: 10, project_id: null, workspace_directory_id: null,
      name: '子目录', version: 3, deleted_at: null },
    { id: 12, user_id: ownerId, parent_id: 10, project_id: null, workspace_directory_id: null,
      name: '先前删除', version: 4, deleted_at: new Date('2026-01-01T00:00:00Z') },
    { id: 13, user_id: foreignOwnerId, parent_id: 10, project_id: null, workspace_directory_id: null,
      name: '他人目录', version: 1, deleted_at: null },
  ]
  const files = [
    { id: 21, user_id: ownerId, folder_id: 11, display_name: '笔记', ext: 'md',
      storage_key: `${ownerId}/个人文件/资料/子目录/笔记.md`, storage_backend: 'local', version: 5, deleted_at: null },
    { id: 22, user_id: ownerId, folder_id: 10, display_name: '旧稿', ext: 'txt',
      storage_key: `${ownerId}/个人文件/资料/旧稿.txt`, storage_backend: 'local', version: 8, deleted_at: new Date('2026-01-02T00:00:00Z') },
    { id: 23, user_id: foreignOwnerId, folder_id: 13, display_name: '他人', ext: 'txt',
      storage_key: `${foreignOwnerId}/个人文件/他人目录/他人.txt`, storage_backend: 'local', version: 1, deleted_at: null },
  ]
  let failFileUpdate = false
  const undoWrites: unknown[][] = []
  const receipts = new Map<string, { method: string; fingerprint: string; result_json: string }>()
  const client = {
    async query<Row extends QueryResultRow = QueryResultRow>(query: string, values: unknown[] = []) {
      const sql = query.replace(/\s+/g, ' ').trim().toUpperCase()
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [], rowCount: 0 }
      if (sql.startsWith('SELECT PG_ADVISORY_XACT_LOCK')) return { rows: [], rowCount: 1 }
      if (sql.includes('FROM CORE_OPERATION_RECEIPTS')) {
        const row = receipts.get(`${String(values[0])}:${String(values[1])}`)
        return { rows: row ? [row] as Row[] : [], rowCount: row ? 1 : 0 }
      }
      if (sql.startsWith('INSERT INTO CORE_OPERATION_RECEIPTS')) {
        receipts.set(`${String(values[0])}:${String(values[1])}`, {
          method: String(values[2]), fingerprint: String(values[3]), result_json: String(values[4]),
        })
        return { rows: [], rowCount: 1 }
      }
      if (sql.startsWith('SELECT CURRENT_TIMESTAMP')) return { rows: [{ deleted_at: new Date('2026-11-15T04:00:00.123Z') } as Row], rowCount: 1 }
      if (sql.includes('WITH RECURSIVE') && sql.includes('FROM FOLDERS')) {
        const root = folders.find(row => row.id === Number(values[0]) && row.user_id === values[1] && row.deleted_at === null)
        if (!root) return { rows: [], rowCount: 0 }
        const ids = new Set<number>([root.id])
        let changed = true
        while (changed) {
          changed = false
          for (const folder of folders) if (folder.deleted_at === null && folder.user_id === values[1]
            && folder.parent_id !== null && ids.has(folder.parent_id) && !ids.has(folder.id)) {
            ids.add(folder.id); changed = true
          }
        }
        return { rows: folders.filter(row => ids.has(row.id)).map(row => ({ ...row })) as Row[], rowCount: ids.size }
      }
      if (sql.startsWith('SELECT ID,USER_ID::TEXT AS USER_ID,FOLDER_ID')) {
        const ids = values.find(Array.isArray) as number[] | undefined
        const rows = files.filter(row => row.user_id === values[0] && row.deleted_at === null && ids?.includes(row.folder_id ?? -1))
        return { rows: rows.map(row => ({ ...row })) as Row[], rowCount: rows.length }
      }
      if (sql.startsWith('SELECT 1 FROM FILES')) return { rows: [], rowCount: 0 }
      if (sql.startsWith('UPDATE FOLDERS SET DELETED_AT')) {
        if (failFileUpdate) throw new Error('synthetic transaction failure')
        const ids = values[0] as number[]
        const stamp = values[2]
        for (const row of folders) if (row.user_id === values[1] && ids.includes(row.id) && row.deleted_at === null) {
          row.deleted_at = stamp as Date; row.version += 1
        }
        return { rows: folders.filter(row => row.user_id === values[1] && ids.includes(row.id)).map(row => ({ ...row })) as Row[], rowCount: ids.length }
      }
      if (sql.startsWith('UPDATE FILES SET STORAGE_KEY')) {
        const row = files.find(file => file.user_id === values[1] && file.id === Number(values[0]))
        if (row) { row.storage_key = String(values[2]); row.deleted_at = values[3] as Date }
        return { rows: [], rowCount: row ? 1 : 0 }
      }
      if (sql.startsWith('UPDATE FILES SET DELETED_AT')) {
        const row = files.find(file => file.id === Number(values[0]) && file.user_id === values[1] && file.deleted_at === null)
        if (row) row.deleted_at = values[2] as Date
        return { rows: [], rowCount: row ? 1 : 0 }
      }
      if (sql.startsWith('UPDATE WORKSPACES SET FOLDER_ID=NULL')) return { rows: [], rowCount: 1 }
      if (sql.startsWith('INSERT INTO UNDO_OPERATIONS')) { undoWrites.push(values); return { rows: [], rowCount: 1 } }
      if (sql.startsWith('UPDATE UNDO_OPERATIONS')) return { rows: [], rowCount: 1 }
      throw new Error(`unexpected SQL: ${sql.slice(0, 100)}`)
    },
    release() {},
  }
  return { folders, files, client, undoWrites, receipts, setFailFileUpdate(value: boolean) { failFileUpdate = value } }
}

test('folder delete soft-deletes the live owned subtree, trashes its live files, and preserves older trash rows', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-folder-delete-'))
  const state = fixture(), events: number[] = []
  const source = path.join(root, ownerId, '个人文件', '资料', '子目录', '笔记.md')
  await mkdir(path.dirname(source), { recursive: true }); await writeFile(source, '正文')
  try {
    const operations = createPostgresFolderDeleteOperations({ connect: async () => state.client } as unknown as Pool, {
      storageRoot: root,
      async captureDirectoryKeys(_client, _owner, folderId) { assert.equal(folderId, 10); return [`${ownerId}/个人文件/资料`, `${ownerId}/个人文件/资料/子目录`] },
      async publishChanged(event) { events.push(event.folderId) },
    })
    await operations.remove(ownerId, 10, { undoContextId: 'undo-folder-10', origin: 'web-test' })

    assert.deepEqual(state.folders.map(row => [row.id, row.deleted_at !== null, row.version]), [
      [10, true, 3], [11, true, 4], [12, true, 4], [13, false, 1],
    ])
    assert.equal(state.files[0]?.deleted_at instanceof Date, true)
    assert.equal(state.files[0]?.storage_key, `${ownerId}/trash/资料/子目录/笔记.md`)
    assert.ok(state.files[1]?.deleted_at, 'folder deletion must leave the previously trashed row unchanged')
    assert.equal(state.files[1]?.storage_key, `${ownerId}/个人文件/资料/旧稿.txt`)
    assert.equal(state.undoWrites.length, 1)
    assert.equal(state.undoWrites[0]?.[2], 'undo-folder-10')
    assert.deepEqual(events, [10])
    assert.equal(await readFile(path.join(root, ownerId, 'trash', '资料', '子目录', '笔记.md'), 'utf8'), '正文')
    await assert.rejects(readFile(source), { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('folder delete leaves storage and events untouched when its database mutation fails', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-folder-delete-rollback-'))
  const state = fixture(), events: number[] = []
  const source = path.join(root, ownerId, '个人文件', '资料', '子目录', '笔记.md')
  await mkdir(path.dirname(source), { recursive: true }); await writeFile(source, '正文')
  state.setFailFileUpdate(true)
  try {
    const operations = createPostgresFolderDeleteOperations({ connect: async () => state.client } as unknown as Pool, {
      storageRoot: root,
      async captureDirectoryKeys() { return [`${ownerId}/个人文件/资料`, `${ownerId}/个人文件/资料/子目录`] },
      async publishChanged(event) { events.push(event.folderId) },
    })
    await assert.rejects(operations.remove(ownerId, 10, { undoContextId: null, origin: null }), /synthetic transaction failure/)
    assert.equal(await readFile(source, 'utf8'), '正文')
    await assert.rejects(readFile(path.join(root, ownerId, 'trash', '资料', '子目录', '笔记.md')), { code: 'ENOENT' })
    assert.deepEqual(events, [])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Agent folder delete commits an owner receipt with the subtree mutation and replays without repeating it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-folder-delete-receipt-'))
  const state = fixture(), events: number[] = []
  const source = path.join(root, ownerId, '个人文件', '资料', '子目录', '笔记.md')
  await mkdir(path.dirname(source), { recursive: true }); await writeFile(source, '正文')
  try {
    const operations = createPostgresFolderDeleteOperations({ connect: async () => state.client } as unknown as Pool, {
      storageRoot: root,
      async captureDirectoryKeys(_client, _owner, folderId) { assert.equal(folderId, 10); return [`${ownerId}/个人文件/资料`] },
      async publishChanged(event) { events.push(event.folderId) },
    })
    const operation = { receipt: { operationId: randomUUID(), fingerprint: 'e'.repeat(64), method: 'agent.file.delete_folder' as const },
      async authorize() {} }
    const first = await operations.remove(ownerId, 10, { undoContextId: 'agent-session-33', origin: null }, operation)
    const replay = await operations.remove(ownerId, 10, { undoContextId: 'agent-session-33', origin: null }, operation)
    assert.deepEqual(replay, first)
    assert.equal(state.receipts.size, 1)
    assert.equal(state.folders.find(folder => folder.id === 10)?.version, 3)
    assert.equal(state.undoWrites.length, 1)
    assert.deepEqual(events, [10])
    assert.equal(await readFile(path.join(root, ownerId, 'trash', '资料', '子目录', '笔记.md'), 'utf8'), '正文')
  } finally { await rm(root, { recursive: true, force: true }) }
})

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
test('isolated PostgreSQL folder delete commits subtree, file trash keys, workspace cleanup, and Undo together', {
  skip: !databaseUrl && '需要显式 GUGU_WEBUI_TEST_DATABASE_URL 运行隔离 PostgreSQL 文件夹删除回归',
}, async () => {
  const schema = `gugu_folder_delete_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-folder-delete-pg-'))
  const source = path.join(root, ownerId, '个人文件', '资料', '子目录', '笔记.md')
  const published: number[] = []
  try {
    await pool.query(`
      CREATE TABLE folders(id integer PRIMARY KEY,user_id uuid NOT NULL,parent_id integer,project_id integer,
        workspace_directory_id integer,name text NOT NULL,version integer NOT NULL,deleted_at timestamptz,updated_at timestamptz);
      CREATE TABLE files(id integer PRIMARY KEY,user_id uuid NOT NULL,folder_id integer,display_name text NOT NULL,
        ext text NOT NULL,storage_key text NOT NULL,storage_backend text NOT NULL,deleted_at timestamptz,updated_at timestamptz);
      CREATE TABLE workspaces(id integer PRIMARY KEY,user_id uuid NOT NULL,folder_id integer);
      CREATE TABLE undo_operations(id text PRIMARY KEY,user_id uuid NOT NULL,undo_context_id text,group_id text,
        resource text,action text,target_refs jsonb,before_state jsonb,after_state jsonb,base_versions jsonb,
        artifact_refs jsonb,actor_type text,status text,created_at timestamptz,expires_at timestamptz,
        undone_at timestamptz,failure_code text);
      CREATE TABLE core_operation_receipts(owner_id uuid NOT NULL,operation_id varchar(36) NOT NULL,method varchar(100) NOT NULL,
        fingerprint varchar(64) NOT NULL,result_json text NOT NULL,created_at timestamptz NOT NULL,
        PRIMARY KEY(owner_id,operation_id));
      INSERT INTO folders VALUES
        (10,'${ownerId}',NULL,NULL,NULL,'资料',2,NULL,CURRENT_TIMESTAMP),
        (11,'${ownerId}',10,NULL,NULL,'子目录',3,NULL,CURRENT_TIMESTAMP),
        (12,'${ownerId}',10,NULL,NULL,'已删除目录',4,'2026-01-01T00:00:00Z',CURRENT_TIMESTAMP);
      INSERT INTO files VALUES
        (21,'${ownerId}',11,'笔记','md','${ownerId}/个人文件/资料/子目录/笔记.md','local',NULL,CURRENT_TIMESTAMP),
        (22,'${ownerId}',10,'旧稿','txt','${ownerId}/个人文件/资料/旧稿.txt','local','2026-01-02T00:00:00Z',CURRENT_TIMESTAMP);
      INSERT INTO workspaces VALUES (31,'${ownerId}',11);
    `)
    await mkdir(path.dirname(source), { recursive: true }); await writeFile(source, '隔离正文')
    const operations = createPostgresFolderDeleteOperations(pool, {
      storageRoot: root,
      async captureDirectoryKeys(_client, _owner, id) { assert.equal(id, 10); return [`${ownerId}/个人文件/资料`, `${ownerId}/个人文件/资料/子目录`] },
      async publishChanged(event) {
        const committed = await pool.query('SELECT deleted_at FROM folders WHERE id=10 AND user_id=$1', [event.ownerId])
        assert.ok(committed.rows[0]?.deleted_at)
        published.push(event.folderId)
      },
    })
    const operation = { receipt: { operationId: randomUUID(), fingerprint: 'f'.repeat(64), method: 'agent.file.delete_folder' as const },
      async authorize() {} }
    const firstResult = await operations.remove(ownerId, 10,
      { undoContextId: 'pg-folder-delete', origin: 'synthetic-client' }, operation)
    const replayedResult = await operations.remove(ownerId, 10,
      { undoContextId: 'pg-folder-delete', origin: 'synthetic-client' }, operation)
    assert.deepEqual(replayedResult, firstResult)

    const rows = await pool.query(`SELECT id,version,deleted_at FROM folders WHERE user_id=$1 ORDER BY id`, [ownerId])
    assert.deepEqual(rows.rows.map(row => [Number(row.id), Number(row.version), row.deleted_at !== null]), [
      [10, 3, true], [11, 4, true], [12, 4, true],
    ])
    const file = await pool.query('SELECT storage_key,deleted_at FROM files WHERE id=21 AND user_id=$1', [ownerId])
    assert.equal(file.rows[0]?.storage_key, `${ownerId}/trash/资料/子目录/笔记.md`)
    assert.ok(file.rows[0]?.deleted_at)
    const priorTrash = await pool.query('SELECT storage_key,deleted_at FROM files WHERE id=22 AND user_id=$1', [ownerId])
    assert.equal(priorTrash.rows[0]?.storage_key, `${ownerId}/个人文件/资料/旧稿.txt`)
    assert.equal(new Date(priorTrash.rows[0]?.deleted_at).toISOString(), '2026-01-02T00:00:00.000Z')
    assert.equal((await pool.query('SELECT folder_id FROM workspaces WHERE id=31')).rows[0]?.folder_id, null)
    assert.equal((await pool.query('SELECT action FROM undo_operations WHERE undo_context_id=$1', ['pg-folder-delete'])).rows[0]?.action, 'delete')
    assert.equal((await pool.query('SELECT count(*)::integer AS count FROM core_operation_receipts WHERE owner_id=$1', [ownerId])).rows[0]?.count, 1)
    assert.equal(await readFile(path.join(root, ownerId, 'trash', '资料', '子目录', '笔记.md'), 'utf8'), '隔离正文')
    await assert.rejects(readFile(source), { code: 'ENOENT' })
    assert.deepEqual(published, [10])
  } finally {
    await rm(root, { recursive: true, force: true })
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})
