import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Pool, type QueryResultRow } from 'pg'
import { createPostgresFileDeleteOperations } from '../../src/modules/files/trash/service.js'
import { lockFileSyncPath } from '../../src/modules/files/storage/sync.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const ownerId = '11111111-1111-4111-8111-111111111111'
const otherOwnerId = '22222222-2222-4222-8222-222222222222'

function fakePool(state: { file: Record<string, unknown>; undoWrites: number; collision: boolean; failUpdate?: boolean; failCommit?: boolean;
  receipts?: Map<string, { method: string; fingerprint: string; result_json: string }>; beforeFailure?: () => Promise<void> }) {
  const client = {
    async query<Row extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim().toUpperCase()
      if (normalized === 'COMMIT' && state.failCommit) throw new Error('模拟提交后断连')
      if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') return { rows: [], rowCount: 0 }
      if (normalized.startsWith('SELECT PG_ADVISORY_XACT_LOCK')) return { rows: [], rowCount: 1 }
      if (normalized.includes('FROM CORE_OPERATION_RECEIPTS')) {
        const receipt = state.receipts?.get(String(values[1]))
        return { rows: receipt ? [receipt as Row] : [], rowCount: receipt ? 1 : 0 }
      }
      if (normalized.startsWith('INSERT INTO CORE_OPERATION_RECEIPTS')) {
        state.receipts?.set(String(values[1]), { method: String(values[2]), fingerprint: String(values[3]), result_json: String(values[4]) })
        return { rows: [], rowCount: 1 }
      }
      if (normalized.startsWith('SELECT * FROM FILES')) {
        if (String(values[0]) !== String(state.file.id) || values[1] !== state.file.user_id || state.file.deleted_at !== null)
          return { rows: [], rowCount: 0 }
        return { rows: [{ ...state.file } as Row], rowCount: 1 }
      }
      if (normalized.startsWith('SELECT 1 FROM FILES'))
        return { rows: [], rowCount: state.collision ? 1 : 0 }
      if (normalized.startsWith('UPDATE FILES SET STORAGE_KEY=')) {
        if (state.failUpdate) { await state.beforeFailure?.(); throw new Error('synthetic database failure') }
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

test('Agent 文件删除在事务内保存 owner 收据并重放原结果而不重复软删', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-file-delete-receipt-'))
  const state = { file: fileRow(), undoWrites: 0, collision: false, receipts: new Map<string, { method: string; fingerprint: string; result_json: string }>() }
  const events: number[] = []
  const source = path.join(root, ownerId, '个人文件', 'notes', 'memo.txt')
  try {
    await mkdir(path.dirname(source), { recursive: true }); await writeFile(source, 'body')
    const operations = createPostgresFileDeleteOperations(fakePool(state), {
      storageRoot: root, async publishChanged(event) { events.push(event.entityId) },
    })
    const operation = { receipt: { operationId: randomUUID(), fingerprint: 'd'.repeat(64), method: 'agent.file.delete_file' as const },
      signal: new AbortController().signal, async authorize() {} }
    const first = await operations.remove(ownerId, 7, 'agent-session-33', null, operation)
    const replay = await operations.remove(ownerId, 7, 'agent-session-33', null, operation)
    assert.deepEqual(replay, { ...first, replayed: true })
    assert.deepEqual(first, { replayed: false, result: { success: true, file_id: 7, name: 'memo.txt',
      note: '已移入回收站，30 天内可还原', _file_op: { op: 'remove', kind: 'file', id: 7 } } })
    assert.equal(state.receipts.size, 1)
    assert.equal(state.file.version, 2)
    assert.equal(state.undoWrites, 1)
    assert.deepEqual(events, [7])
    assert.equal(await readFile(path.join(root, ownerId, 'trash', 'notes', 'memo.txt'), 'utf8'), 'body')
    await assert.rejects(readFile(source), { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Agent 批量软删除遇到 owner 缺失 ID 时在任何磁盘/Undo 副作用前整体失败', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-file-delete-batch-missing-'))
  const state = { file: fileRow(), undoWrites: 0, collision: false, receipts: new Map<string, { method: string; fingerprint: string; result_json: string }>() }
  const events: number[] = []
  try {
    const source = path.join(root, ownerId, '个人文件', 'notes', 'memo.txt')
    await mkdir(path.dirname(source), { recursive: true })
    await writeFile(source, 'body')
    const operations = createPostgresFileDeleteOperations(fakePool(state), {
      storageRoot: root,
      async publishChanged(event) { events.push(event.entityId) },
    })
    const operation = { receipt: { operationId: randomUUID(), fingerprint: 'b'.repeat(64), method: 'agent.file.delete_file' as const },
      signal: new AbortController().signal, async authorize() {} }
    await assert.rejects(operations.removeMany!(ownerId, [7, 999], 'undo-context', 'renderer', operation), /文件不存在/)
    assert.equal(await readFile(source, 'utf8'), 'body')
    assert.equal(state.file.deleted_at, null)
    assert.equal(state.undoWrites, 0)
    assert.deepEqual(events, [])
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
      CREATE TABLE core_operation_receipts (
        owner_id uuid NOT NULL, operation_id varchar(36) NOT NULL, fingerprint varchar(64) NOT NULL,
        method varchar(100) NOT NULL, result_json text NOT NULL, created_at timestamptz NOT NULL,
        PRIMARY KEY(owner_id,operation_id)
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
      const receiptOperation = { receipt: { operationId: randomUUID(), fingerprint: 'a'.repeat(64), method: 'agent.file.delete_file' as const },
        signal: new AbortController().signal, async authorize() {} }
      let result: unknown
      const removal = operations.remove(ownerId, 1, 'editor-tab', 'renderer', receiptOperation).then((value) => {
        result = value
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
      assert.deepEqual(result, { replayed: false, result: { success: true, file_id: 1, name: '笔记.md',
        note: '已移入回收站，30 天内可还原', _file_op: { op: 'remove', kind: 'file', id: 1 } } })
      assert.equal((await pool.query('SELECT operation_id FROM core_operation_receipts WHERE owner_id=$1', [ownerId])).rowCount, 1)
      assert.deepEqual(await operations.remove(ownerId, 1, 'editor-tab', 'renderer', receiptOperation),
        { replayed: true, result: (result as { result: Record<string, unknown> }).result })
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
    const corrupt = await pool.query<{id:number}>(`INSERT INTO files(user_id,display_name,ext,space,stage_name,storage_key,version,size,size_bytes,mime_type,created_at,updated_at) VALUES($1,'私有','txt','personal','',$2,1,'4 B',4,'text/plain',now(),now()) RETURNING id`,[ownerId,`${otherOwnerId}/个人文件/私有.txt`])
    await assert.rejects(operations.removeMany!(ownerId,[corrupt.rows[0]!.id],null,null),/文件不存在/)
    assert.equal(await readFile(foreignSource,'utf8'),'其他用户正文')
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
    await rm(root, { recursive: true, force: true })
  }
})

test('并发删除重名文件时两份正文都保存在回收站', { skip: !databaseUrl && '需要隔离 PostgreSQL' }, async () => {
  const schema = `gugu_delete_race_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 3 })
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-delete-race-'))
  try {
    await pool.query(`CREATE TABLE files (id serial PRIMARY KEY,user_id uuid,display_name text,ext text,space text,project_id int,folder_id int,workspace_directory_id int,stage_name text,mind_map_id int,storage_key text,version int,size text,size_bytes bigint,mime_type text,img_width int,img_height int,deleted_at timestamptz,updated_at timestamptz);
      INSERT INTO files(user_id,display_name,ext,space,stage_name,storage_key,version,size,size_bytes) VALUES
      ('${ownerId}','memo','txt','personal','','${ownerId}/个人文件/notes/memo.txt',1,'1 B',1),
      ('${ownerId}','memo','txt','project','','${ownerId}/项目文件/notes/memo.txt',1,'1 B',1)`)
    for (const [dir, body] of [['个人文件','A'],['项目文件','B']]) {
      const source = path.join(root, ownerId, dir!, 'notes', 'memo.txt')
      await mkdir(path.dirname(source), { recursive: true }); await writeFile(source, body!)
    }
    let arrivals = 0
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    const wrapped = { async connect() {
      const client = await pool.connect()
      const original = client.query.bind(client)
      client.query = (async (...args: Parameters<typeof client.query>) => {
        const result = await (original as (...args: any[]) => Promise<any>)(...args)
        if (typeof args[0] === 'string' && args[0].startsWith('SELECT 1 FROM files WHERE user_id=')) {
          if (++arrivals === 2) release()
          await Promise.race([barrier, new Promise(resolve => setTimeout(resolve, 300))])
        }
        return result
      }) as typeof client.query
      return client
    } } as unknown as Pool
    const ops = createPostgresFileDeleteOperations(wrapped, { storageRoot: root, async publishChanged() {} })
    await Promise.all([ops.remove(ownerId, 1, null, null), ops.remove(ownerId, 2, null, null)])
    const rows = await pool.query<{storage_key:string}>('SELECT storage_key FROM files ORDER BY id')
    assert.equal(new Set(rows.rows.map(row => row.storage_key)).size, 2)
    const contents = await Promise.all(rows.rows.map(row => readFile(path.join(root, ...row.storage_key.split('/')), 'utf8')))
    assert.deepEqual(contents.sort(), ['A', 'B'])
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); await rm(root, {recursive:true,force:true}) }
})

test('删除提交结果未知时保留原路径和回收站正文', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'gugu-delete-unknown-'))
  const state={file:fileRow(),undoWrites:0,collision:false,failCommit:true}
  const source=path.join(root,ownerId,'个人文件','notes','memo.txt')
  const target=path.join(root,ownerId,'trash','notes','memo.txt')
  try {
    await mkdir(path.dirname(source),{recursive:true});await writeFile(source,'正文')
    const ops=createPostgresFileDeleteOperations(fakePool(state),{storageRoot:root,async publishChanged(){throw new Error('不应发布')}})
    await assert.rejects(ops.remove(ownerId,7,null,null),/模拟提交后断连/)
    assert.equal(await readFile(source,'utf8'),'正文');assert.equal(await readFile(target,'utf8'),'正文')
  } finally {await rm(root,{recursive:true,force:true})}
})

test('删除失败回滚不覆盖并发创建的原路径', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'gugu-delete-rollback-race-'))
  const source=path.join(root,ownerId,'个人文件','notes','memo.txt')
  const target=path.join(root,ownerId,'trash','notes','memo.txt')
  const state={file:fileRow(),undoWrites:0,collision:false,failUpdate:true,async beforeFailure(){await unlink(source);await writeFile(source,'并发新正文')}}
  try {
    await mkdir(path.dirname(source),{recursive:true});await writeFile(source,'原正文')
    const ops=createPostgresFileDeleteOperations(fakePool(state),{storageRoot:root,async publishChanged(){}})
    await assert.rejects(ops.remove(ownerId,7,null,null),/synthetic database failure/)
    assert.equal(await readFile(source,'utf8'),'并发新正文')
    assert.equal(await readFile(target,'utf8'),'原正文')
  } finally {await rm(root,{recursive:true,force:true})}
})

test('文件系统不支持硬链接时删除失败并保留源正文', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'gugu-delete-exdev-'))
  const state={file:fileRow(),undoWrites:0,collision:false}
  const source=path.join(root,ownerId,'个人文件','notes','memo.txt')
  try {
    await mkdir(path.dirname(source),{recursive:true});await writeFile(source,'原正文')
    const ops=createPostgresFileDeleteOperations(fakePool(state),{storageRoot:root,async createDeleteLink(){throw Object.assign(new Error('不支持'),{code:'EXDEV'})},async publishChanged(){throw new Error('不应发布')}})
    await assert.rejects(ops.remove(ownerId,7,null,null),{code:'EXDEV'})
    assert.equal(await readFile(source,'utf8'),'原正文');assert.equal(state.file.deleted_at,null)
  } finally {await rm(root,{recursive:true,force:true})}
})

test('损坏的跨用户存储 key 不得删除另一用户正文', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'gugu-delete-owner-key-'))
  const foreign=path.join(root,otherOwnerId,'个人文件','memo.txt')
  const state={file:{...fileRow(),storage_key:`${otherOwnerId}/个人文件/memo.txt`},undoWrites:0,collision:false}
  try {
    await mkdir(path.dirname(foreign),{recursive:true});await writeFile(foreign,'他人正文')
    const ops=createPostgresFileDeleteOperations(fakePool(state),{storageRoot:root,async publishChanged(){throw new Error('不应发布')}})
    await assert.rejects(ops.remove(ownerId,7,null,null),/文件不存在/)
    assert.equal(await readFile(foreign,'utf8'),'他人正文')
  } finally {await rm(root,{recursive:true,force:true})}
})
