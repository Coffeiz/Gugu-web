import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Pool, type QueryResultRow } from 'pg'
import { createPostgresFileDeleteOperations } from '../../src/domains/files/file-delete-postgres.js'
import { lockFileSyncPath } from '../../src/domains/files/persistence/file-sync-canonical-change.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const ownerId = '11111111-1111-4111-8111-111111111111'
const otherOwnerId = '22222222-2222-4222-8222-222222222222'

function fakePool(state: { file: Record<string, unknown>; undoWrites: number; collision: boolean; failUpdate?: boolean }) {
  const client = {
    async query<Row extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim().toUpperCase()
      if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') return { rows: [], rowCount: 0 }
      if (normalized.startsWith('SELECT PG_ADVISORY_XACT_LOCK')) return { rows: [], rowCount: 1 }
      if (normalized.startsWith('SELECT * FROM FILES')) {
        if (String(values[0]) !== String(state.file.id) || values[1] !== state.file.user_id || state.file.deleted_at !== null)
          return { rows: [], rowCount: 0 }
        return { rows: [{ ...state.file } as Row], rowCount: 1 }
      }
      if (normalized.startsWith('SELECT 1 FROM FILES'))
        return { rows: [], rowCount: state.collision ? 1 : 0 }
      if (normalized.startsWith('UPDATE FILES SET STORAGE_KEY=')) {
        if (state.failUpdate) throw new Error('synthetic database failure')
        state.file.storage_key = values[2]
        state.file.deleted_at = new Date('2026-11-13T01:02:03.000Z')
        state.file.version = Number(state.file.version) + 1
        return { rows: [{ ...state.file } as Row], rowCount: 1 }
      }
      if (normalized.startsWith('INSERT INTO UNDO_OPERATIONS')) {
        state.undoWrites++
        return { rows: [], rowCount: 1 }
      }
      if (normalized.startsWith('UPDATE UNDO_OPERATIONS')) return { rows: [], rowCount: 0 }
      throw new Error(`unexpected SQL in test adapter: ${normalized.slice(0, 80)}`)
    },
    release() {},
  }
  return { connect: async () => client } as unknown as Pool
}

function fileRow() {
  return {
    id: 7, user_id: ownerId, display_name: 'memo', ext: 'txt', space: 'personal',
    project_id: null, folder_id: null, workspace_directory_id: null, stage_name: '', mind_map_id: null,
    storage_key: `${ownerId}/个人文件/notes/memo.txt`, version: 1, size: '4 B', size_bytes: 4,
    mime_type: 'text/plain', img_width: null, img_height: null, deleted_at: null,
  }
}

test('Local 删除将正文移入回收站、递增版本并保存撤销状态', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-file-delete-'))
  const state = { file: fileRow(), undoWrites: 0, collision: false }
  const events: number[] = []
  try {
    const source = path.join(root, ownerId, '个人文件', 'notes', 'memo.txt')
    await mkdir(path.dirname(source), { recursive: true })
    await writeFile(source, 'body')
    const operations = createPostgresFileDeleteOperations(fakePool(state), {
      storageRoot: root,
      async publishChanged(event) { events.push(event.entityId) },
    })

    await operations.remove(ownerId, 7, 'undo-context', 'renderer')

    const target = path.join(root, ownerId, 'trash', 'notes', 'memo.txt')
    assert.equal(await readFile(target, 'utf8'), 'body')
    await assert.rejects(readFile(source), { code: 'ENOENT' })
    assert.equal(state.file.storage_key, `${ownerId}/trash/notes/memo.txt`)
    assert.notEqual(state.file.deleted_at, null)
    assert.equal(state.file.version, 2)
    assert.equal(state.undoWrites, 1)
    assert.deepEqual(events, [7])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Local 删除不访问或移动其他 owner 的文件', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-file-delete-owner-'))
  const state = { file: fileRow(), undoWrites: 0, collision: false }
  try {
    const source = path.join(root, ownerId, '个人文件', 'notes', 'memo.txt')
    await mkdir(path.dirname(source), { recursive: true })
    await writeFile(source, 'body')
    const operations = createPostgresFileDeleteOperations(fakePool(state), {
      storageRoot: root,
      async publishChanged() {},
    })

    await assert.rejects(operations.remove(otherOwnerId, 7, null, null), (error: unknown) =>
      error instanceof Error && error.message === '文件不存在')
    assert.equal(await readFile(source, 'utf8'), 'body')
    assert.equal(state.undoWrites, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('数据库更新失败时回滚物理移动并保留原文件', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-file-delete-rollback-'))
  const state = { file: fileRow(), undoWrites: 0, collision: false, failUpdate: true }
  try {
    const source = path.join(root, ownerId, '个人文件', 'notes', 'memo.txt')
    await mkdir(path.dirname(source), { recursive: true })
    await writeFile(source, 'body')
    const operations = createPostgresFileDeleteOperations(fakePool(state), {
      storageRoot: root,
      async publishChanged() { assert.fail('回滚写入不得发布删除事件') },
    })

    await assert.rejects(operations.remove(ownerId, 7, 'undo-context', null), /synthetic database failure/)
    assert.equal(await readFile(source, 'utf8'), 'body')
    assert.equal(state.file.storage_key, `${ownerId}/个人文件/notes/memo.txt`)
    assert.equal(state.file.deleted_at, null)
    assert.equal(state.undoWrites, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('PostgreSQL Local 删除等待 filesync 路径锁，再移动正文、记录 Undo 并发布资源事件', {
  skip: !databaseUrl && '设置 GUGU_WEBUI_TEST_DATABASE_URL 后运行隔离 PostgreSQL 文件删除回归',
}, async () => {
  const schema = `gugu_file_delete_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-file-delete-pg-'))
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
      CREATE TABLE undo_operations (
        id text PRIMARY KEY, user_id uuid NOT NULL, undo_context_id text, group_id text, resource text,
        action text, target_refs jsonb, before_state jsonb, after_state jsonb, base_versions jsonb,
        artifact_refs jsonb, actor_type text, status text, created_at timestamptz, expires_at timestamptz,
        undone_at timestamptz, failure_code text
      );
      INSERT INTO files (user_id,display_name,ext,space,stage_name,storage_key,version,size,size_bytes,
        mime_type,created_at,updated_at) VALUES
        ('${ownerId}','笔记','md','personal','','${ownerId}/个人文件/资料/笔记.md',4,'6 B',6,
         'text/markdown',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
        ('${ownerId}','a','txt','personal','','${ownerId}/个人文件/a.txt',1,'4 B',4,
         'text/plain',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
        ('${otherOwnerId}','私有','txt','personal','','${otherOwnerId}/个人文件/私有.txt',1,'4 B',4,
         'text/plain',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
        ('${ownerId}','z','txt','personal','','${ownerId}/个人文件/z.txt',1,'4 B',4,
         'text/plain',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
    `)
    const source = path.join(root, ownerId, '个人文件', '资料', '笔记.md')
    await mkdir(path.dirname(source), { recursive: true })
    await writeFile(source, '正文内容')
    const firstBatchSource = path.join(root, ownerId, '个人文件', 'a.txt')
    await mkdir(path.dirname(firstBatchSource), { recursive: true })
    await writeFile(firstBatchSource, '批量正文 A')
    const secondBatchSource = path.join(root, ownerId, '个人文件', 'z.txt')
    await writeFile(secondBatchSource, '批量正文 Z')
    const foreignSource = path.join(root, otherOwnerId, '个人文件', '私有.txt')
    await mkdir(path.dirname(foreignSource), { recursive: true })
    await writeFile(foreignSource, '其他用户正文')
    const operations = createPostgresFileDeleteOperations(pool, {
      storageRoot: root,
      async publishChanged(event) {
        const committed = await pool.query<{ deleted_at: Date | null; storage_key: string }>(
          'SELECT deleted_at,storage_key FROM files WHERE id=$1 AND user_id=$2', [event.entityId, ownerId],
        )
        assert.ok(committed.rows[0]?.deleted_at)
        const expectedKey = new Map<number, string>([
          [1, `${ownerId}/trash/资料/笔记.md`], [2, `${ownerId}/trash/a.txt`], [4, `${ownerId}/trash/z.txt`],
        ]).get(event.entityId)
        assert.equal(committed.rows[0]?.storage_key, expectedKey)
        events.push(event.entityId)
      },
    })

    const lockHolder = await pool.connect()
    try {
      const sourceKey = `${ownerId}/个人文件/资料/笔记.md`
      await lockHolder.query('BEGIN')
      await lockFileSyncPath(lockHolder, ownerId, sourceKey)
      let settled = false
      let operationError: unknown
      const removal = operations.remove(ownerId, 1, 'editor-tab', 'renderer').then(() => {
        settled = true
      }, (error: unknown) => {
        settled = true
        operationError = error
      })
      await new Promise((resolve) => setTimeout(resolve, 80))
      assert.equal(settled, false, '删除应先等待与 Python 文件同步相同的路径事务锁')
      await lockHolder.query('COMMIT')
      await removal
      if (operationError) throw operationError
    } finally {
      await lockHolder.query('ROLLBACK').catch(() => undefined)
      lockHolder.release()
    }

    const file = await pool.query<{ storage_key: string; version: number; deleted_at: Date | null }>(
      'SELECT storage_key,version,deleted_at FROM files WHERE id=1 AND user_id=$1', [ownerId],
    )
    assert.equal(file.rows[0]?.storage_key, `${ownerId}/trash/资料/笔记.md`)
    assert.equal(file.rows[0]?.version, 5)
    assert.ok(file.rows[0]?.deleted_at)
    assert.equal(await readFile(path.join(root, ownerId, 'trash', '资料', '笔记.md'), 'utf8'), '正文内容')
    await assert.rejects(readFile(source), { code: 'ENOENT' })
    const undo = await pool.query<{ before_state: { items: Record<string, { version: number }> } }>(
      'SELECT before_state FROM undo_operations WHERE user_id=$1 AND undo_context_id=$2', [ownerId, 'editor-tab'],
    )
    assert.equal(undo.rows[0]?.before_state.items['file:1']?.version, 4)
    await pool.query(`
      CREATE FUNCTION reject_second_batch_delete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id=4 THEN RAISE EXCEPTION 'synthetic batch update failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_second_batch_delete BEFORE UPDATE ON files
      FOR EACH ROW EXECUTE FUNCTION reject_second_batch_delete();
    `)
    await assert.rejects(operations.removeMany!(ownerId, [2, 4], 'failed-batch-tab', 'renderer'), /synthetic batch update failure/)
    assert.equal(await readFile(firstBatchSource, 'utf8'), '批量正文 A')
    assert.equal(await readFile(secondBatchSource, 'utf8'), '批量正文 Z')
    const rolledBack = await pool.query<{ id: number; deleted_at: Date | null; storage_key: string }>(
      'SELECT id,deleted_at,storage_key FROM files WHERE id=ANY($1::integer[]) ORDER BY id', [[2, 4]],
    )
    assert.deepEqual(rolledBack.rows.map((row) => [row.id, row.deleted_at, row.storage_key]), [
      [2, null, `${ownerId}/个人文件/a.txt`], [4, null, `${ownerId}/个人文件/z.txt`],
    ])
    assert.deepEqual(events, [1])
    await pool.query('DROP TRIGGER reject_second_batch_delete ON files; DROP FUNCTION reject_second_batch_delete()')
    await operations.removeMany!(ownerId, [2, 3, 4], 'batch-editor-tab', 'renderer')
    assert.equal(await readFile(path.join(root, ownerId, 'trash', 'a.txt'), 'utf8'), '批量正文 A')
    assert.equal(await readFile(path.join(root, ownerId, 'trash', 'z.txt'), 'utf8'), '批量正文 Z')
    assert.equal(await readFile(foreignSource, 'utf8'), '其他用户正文')
    const batchUndo = await pool.query<{
      target_refs: Array<{ kind: string; id: number }>
      before_state: { items: Record<string, { version: number }> }
    }>(
      'SELECT target_refs,before_state FROM undo_operations WHERE user_id=$1 AND undo_context_id=$2',
      [ownerId, 'batch-editor-tab'],
    )
    assert.deepEqual(batchUndo.rows[0]?.target_refs, [{ kind: 'file', id: 2 }, { kind: 'file', id: 4 }])
    assert.equal(batchUndo.rows[0]?.before_state.items['file:2']?.version, 1)
    assert.equal(batchUndo.rows[0]?.before_state.items['file:4']?.version, 1)
    assert.deepEqual(events, [1, 2, 4])
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
    await rm(root, { recursive: true, force: true })
  }
})
