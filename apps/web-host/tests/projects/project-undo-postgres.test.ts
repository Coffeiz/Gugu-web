import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Pool } from 'pg'
import { sql } from 'kysely'
import { projectResponse, type ProjectRecord } from '@gugu/core'
import { createHostCoreUndoOperations } from '../../src/modules/undo/service.js'
import { createPostgresRuntime, tablesSql } from '@gugu/core/data'
import { createRuntimeUndoTransactionPort } from '@gugu/core/undo'
import { createLocalProjectDirectoryRenamer } from '../../src/modules/projects/update.js'
import { createLocalProjectTrashStorage, projectFileTrashKey } from '../../src/modules/projects/lifecycle/storage.js'
import type { ProjectTrashFile } from '@gugu/core/project-trash'
import { createPostgresProjectDeleteJournal, recoverProjectUndoJournal, saveProjectUndoJournal } from '../../src/modules/undo/journal.js'
import { createLocalProjectUndoJournalStorage } from '../../src/modules/undo/journal.js'
import { directoryPort } from './fixtures/directory-port.js'
import { startProjectDeleteRecoveryWorker } from '../../src/modules/projects/lifecycle/recovery.js'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL
test('Agent 项目删除日志在物理移动前落库，后台跳过活动操作并按收据恢复', { skip: !url, timeout: 15_000 }, async () => {
  const admin = new Pool({ connectionString: url })
  const schema = `gugu_agent_project_journal_${randomUUID().replaceAll('-', '')}`
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-agent-project-journal-'))
  const core = await createPostgresRuntime({ url: url!, schema })
  const ownerId = randomUUID()
  const context = { ownerId }
  const storage = createLocalProjectUndoJournalStorage(root)
  const journal = () => createPostgresProjectDeleteJournal(pool, storage)
  const logs = async () => (await pool.query('SELECT user_id::text,operation_id,moves FROM project_undo_journals ORDER BY operation_id')).rows
  const moved = new Error('在文件发布后中断调用')
  let workerErrors = 0
  const runRecovery = () => startProjectDeleteRecoveryWorker({
    pool, storageRoot: root, onError: () => { workerErrors++ },
  }).stop()
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await pool.query(tablesSql('postgres').receipts)
    await pool.query(`CREATE TABLE project_undo_journals (id uuid PRIMARY KEY,user_id uuid NOT NULL,operation_id varchar(64) NOT NULL,
      before_status varchar(16) NOT NULL,after_status varchar(16) NOT NULL,moves json NOT NULL,created_at timestamptz NOT NULL,UNIQUE(user_id,operation_id))`)
    await pool.query('CREATE TABLE files(user_id uuid,path text,deleted_at timestamptz,PRIMARY KEY(user_id,path))')
    await mkdir(path.join(root, ownerId))
    const from = `${ownerId}/source.txt`, to = `${ownerId}/trash.txt`
    const otherFrom = `${ownerId}/other.txt`, otherTo = `${ownerId}/other-trash.txt`
    await writeFile(path.join(root, from), '合成原文')
    await writeFile(path.join(root, otherFrom), '另一文件')
    await pool.query('INSERT INTO files VALUES ($1,$2,NULL),($1,$3,NULL)', [ownerId, from, otherFrom])
    const operation = randomUUID()
    await assert.rejects(journal().withJournal(ownerId, operation, async (log) => {
      await log.record(from, to)
      assert.deepEqual(await logs(), [{ user_id: ownerId, operation_id: operation, moves: [{ from, to }] }])
      const lock = await pool.query("SELECT pg_try_advisory_xact_lock(hashtext('gugu-project-undo-journal')) AS acquired")
      assert.equal(lock.rows[0].acquired, false)
      await storage.move(ownerId, from, to)
      await log.record(otherFrom, otherTo)
      await storage.move(ownerId, otherFrom, otherTo)
      await runRecovery()
      assert.equal(await storage.exists(ownerId, from), false)
      assert.equal((await logs()).length, 1)
      throw moved
    }), error => error === moved)
    await journal().recoverJournal(randomUUID(), operation)
    assert.equal((await logs()).length, 1)
    assert.equal(await readFile(path.join(root, to), 'utf8'), '合成原文')
    const fileLock = await pool.connect()
    try {
      await fileLock.query('BEGIN')
      await fileLock.query('SELECT path FROM files WHERE user_id=$1 AND path=$2 FOR UPDATE', [ownerId, from])
      await runRecovery()
      assert.equal((await logs()).length, 1)
      assert.equal(workerErrors, 0)
    } finally {
      await fileLock.query('ROLLBACK')
      fileLock.release()
    }
    await runRecovery()
    assert.deepEqual(await logs(), [])
    assert.equal(await readFile(path.join(root, from), 'utf8'), '合成原文')
    assert.equal(await readFile(path.join(root, otherFrom), 'utf8'), '另一文件')
    assert.equal(await storage.exists(ownerId, otherTo), false)
    assert.equal(await storage.exists(ownerId, to), false)

    const committed = randomUUID()
    await assert.rejects(journal().withJournal(ownerId, committed, async log => {
      await log.record(from, to)
      await storage.move(ownerId, from, to)
      await core.operationWithTransaction(context, committed, 'agent.project.delete', {}, async tx => {
        await sql`UPDATE files SET path=${to},deleted_at=CURRENT_TIMESTAMP WHERE user_id=${ownerId} AND path=${from}`.execute(tx)
        return { success: true }
      })
      throw moved
    }), error => error === moved)
    assert.equal((await logs()).length, 1)
    await pool.query('UPDATE files SET path=$1 WHERE user_id=$2 AND path=$3', [from, ownerId, to])
    const otherOperation = randomUUID()
    await assert.rejects(journal().withJournal(ownerId, otherOperation, async log => {
      await log.record(otherFrom, otherTo)
      await storage.move(ownerId, otherFrom, otherTo)
      throw moved
    }), error => error === moved)
    await runRecovery()
    assert.equal((await logs()).length, 1)
    assert.equal(workerErrors, 1)
    assert.equal(await readFile(path.join(root, otherFrom), 'utf8'), '另一文件')
    assert.equal(await readFile(path.join(root, to), 'utf8'), '合成原文')
    await pool.query('UPDATE files SET path=$1 WHERE user_id=$2 AND path=$3', [to, ownerId, from])
    await journal().recoverJournal(ownerId, committed)
    assert.equal(await readFile(path.join(root, to), 'utf8'), '合成原文')
    assert.equal(await storage.exists(ownerId, from), false)
    assert.deepEqual(await logs(), [])
  } finally {
    await core.close()
    await pool.end()
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) }
    finally { await admin.end(); await rm(root, { recursive: true, force: true }) }
  }
})

test('项目撤销改名时协调显式目录端口与数据库路径，重做可恢复', { skip: !url }, async () => {
  const admin = new Pool({ connectionString: url })
  const schema = `gugu_project_undo_${randomUUID().replaceAll('-', '')}`
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-project-undo-'))
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema} -c timezone=Asia/Shanghai` })
  const runtime = await createPostgresRuntime({ url: url!, schema })
  try {
    await pool.query(`CREATE TABLE projects (id integer PRIMARY KEY,user_id text,name text,start_date text,created_at timestamptz,version integer,stages_json text)`)
    await pool.query(`ALTER TABLE projects ADD COLUMN summary text, ADD COLUMN contact_name text,
      ADD COLUMN status text DEFAULT 'active', ADD COLUMN deadline text,
      ADD COLUMN color text DEFAULT 'synthetic-color', ADD COLUMN progress integer DEFAULT 0,
      ADD COLUMN current_stage text, ADD COLUMN priority text, ADD COLUMN archived boolean DEFAULT false,
      ADD COLUMN done_at timestamptz, ADD COLUMN deleted_at timestamptz,
      ADD COLUMN updated_at timestamptz DEFAULT '2026-01-01T00:30:00.123456+08:00'`)

    await pool.query(`CREATE TABLE files (user_id text,project_id integer,path text,version integer,PRIMARY KEY(user_id,path))`)
    await pool.query(`CREATE TABLE undo_operations (id text PRIMARY KEY,user_id text,undo_context_id text,group_id text,resource text,action text,target_refs json,before_state json,after_state json,actor_type text,status varchar(16),created_at timestamptz,expires_at timestamptz,undone_at timestamptz,failure_code text)`)
    await pool.query(`CREATE TABLE project_undo_journals (id uuid PRIMARY KEY,user_id text,operation_id text,before_status text,after_status text,moves json,created_at timestamptz)`)
    const oldKey = '11111111-1111-4111-8111-111111111111/项目文件/2026/01/旧 #1', newKey = '11111111-1111-4111-8111-111111111111/项目文件/2026/01/新 #1'
    const directories = directoryPort(newKey, '内容')
    await pool.query(`INSERT INTO projects (id,user_id,name,start_date,created_at,version,stages_json) VALUES (1,'11111111-1111-4111-8111-111111111111','新','2026-01-01','2026-01-01T00:30:00.123000+08:00',2,'[]')`)
    await pool.query(`INSERT INTO files VALUES ('11111111-1111-4111-8111-111111111111',1,$1)`, [`${newKey}/a.txt`])
    await pool.query(`INSERT INTO undo_operations VALUES ('op','11111111-1111-4111-8111-111111111111','ctx','g','projects','update','[]',$1::json,$2::json,'web','active',now(),now()+interval '1 day',NULL,NULL)`, [JSON.stringify({ items: { 'project:1': { name: '旧', stages: [] } } }), JSON.stringify({ items: { 'project:1': { name: '新', stages: [], version: 2 } } })])
    const notifications: Record<string, unknown>[] = []
    const reread = async () => projectResponse((await pool.query(`SELECT *, contact_name AS client,
      created_at::text AS created_at,updated_at::text AS updated_at,done_at::text AS done_at,
      deleted_at::text AS deleted_at FROM projects WHERE id=1`)).rows[0] as ProjectRecord, 0)
    const service = createHostCoreUndoOperations(pool, createRuntimeUndoTransactionPort(runtime), async (_owner, event) => { notifications.push(event) }, { renameDirectory: directories.renameDirectory, trash: createLocalProjectTrashStorage(root) })
    const undone = await service.apply('11111111-1111-4111-8111-111111111111', 'ctx', 'op', 'undo') as { events: Record<string, unknown>[] }
    assert.deepEqual(undone.events, [{ resource: 'projects', operation: 'update', entity_ids: [1], origin: 'undo:op' }])
    const afterUndo = await reread()
    assert.equal(afterUndo.name, '旧')
    assert.equal(afterUndo.createdAt, '2025-12-31')
    assert.equal(afterUndo.updatedAt, '2025-12-31T16:30:00.123456+00:00')
    assert.equal(afterUndo.doneAt, null)
    assert.equal(afterUndo.deletedAt, null)
    assert.equal(directories.contents(oldKey), '内容')
    assert.equal((await pool.query('SELECT path FROM files')).rows[0].path, `${oldKey}/a.txt`)
    const redone = await service.apply('11111111-1111-4111-8111-111111111111', 'ctx', 'op', 'redo') as { events: Record<string, unknown>[] }
    assert.deepEqual(redone.events, [{ resource: 'projects', operation: 'update', entity_ids: [1], origin: 'undo:op' }])
    assert.deepEqual(notifications, [...undone.events, ...redone.events])
    const afterRedo = await reread()
    assert.equal(afterRedo.name, '新')
    assert.equal(afterRedo.createdAt, '2025-12-31')
    assert.equal(afterRedo.updatedAt, '2025-12-31T16:30:00.123456+00:00')
    assert.equal(afterRedo.doneAt, null)
    assert.equal(afterRedo.deletedAt, null)
    assert.equal(directories.contents(newKey), '内容')
    await pool.query(`ALTER TABLE projects ADD CONSTRAINT reject_name CHECK (name <> '失败')`)
    await pool.query(`INSERT INTO undo_operations VALUES ('fail','11111111-1111-4111-8111-111111111111','ctx','g','projects','update','[]',$1::json,$2::json,'web','active',now(),now()+interval '1 day',NULL,NULL)`, [JSON.stringify({ items: { 'project:1': { name: '失败', stages: [] } } }), JSON.stringify({ items: { 'project:1': { name: '新', stages: [], version: 4 } } })])
    await assert.rejects(() => service.apply('11111111-1111-4111-8111-111111111111', 'ctx', 'fail', 'undo'))
    assert.equal(directories.contents(newKey), '内容')
    assert.equal((await pool.query('SELECT path FROM files')).rows[0].path, `${newKey}/a.txt`)
  } finally {
    await runtime.close()
    await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin.end()
    await rm(root, { recursive: true, force: true })
  }
})

test('进程中断后根据数据库终态恢复文件，冲突保留日志', { skip: !url }, async () => {
  const admin = new Pool({ connectionString: url })
  const schema = `gugu_project_recovery_${randomUUID().replaceAll('-', '')}`
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-project-recovery-'))
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema} -c timezone=Asia/Shanghai` })
  const runtime = await createPostgresRuntime({ url: url!, schema })
  try {
    await pool.query(`CREATE TABLE undo_operations (id text PRIMARY KEY,user_id text,status varchar(16))`)
    await pool.query(`CREATE TABLE project_undo_journals (id uuid PRIMARY KEY,user_id text,operation_id text,before_status text,after_status text,moves json,created_at timestamptz)`)
    await pool.query(`INSERT INTO undo_operations VALUES ('op','11111111-1111-4111-8111-111111111111','active')`)
    const id = randomUUID()
    await saveProjectUndoJournal(pool, { id, ownerId: '11111111-1111-4111-8111-111111111111', operationId: 'op', beforeStatus: 'active', afterStatus: 'undone', moves: [{ from: '11111111-1111-4111-8111-111111111111/a', to: '11111111-1111-4111-8111-111111111111/b' }] })
    await mkdir(path.join(root, '11111111-1111-4111-8111-111111111111'))
    await writeFile(path.join(root, '11111111-1111-4111-8111-111111111111', 'b'), '已移动')
    const storage = createLocalProjectUndoJournalStorage(root)
    await recoverProjectUndoJournal(pool, storage)
    assert.equal(await readFile(path.join(root, '11111111-1111-4111-8111-111111111111', 'a'), 'utf8'), '已移动')
    await saveProjectUndoJournal(pool, { id: randomUUID(), ownerId: '11111111-1111-4111-8111-111111111111', operationId: 'op', beforeStatus: 'active', afterStatus: 'undone', moves: [{ from: '11111111-1111-4111-8111-111111111111/a', to: '11111111-1111-4111-8111-111111111111/b' }] })
    await writeFile(path.join(root, '11111111-1111-4111-8111-111111111111', 'b'), '冲突')
    await assert.rejects(() => recoverProjectUndoJournal(pool, storage))
    assert.equal(Number((await pool.query('SELECT count(*) AS count FROM project_undo_journals')).rows[0].count), 1)
    assert.equal(await readFile(path.join(root, '11111111-1111-4111-8111-111111111111', 'a'), 'utf8'), '已移动')
  } finally {
    await runtime.close()
    await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin.end()
    await rm(root, { recursive: true, force: true })
  }
})

test('项目删除的撤销与重做移动本地文件并保持 owner 隔离', { skip: !url }, async () => {
  const admin = new Pool({ connectionString: url })
  const schema = `gugu_project_delete_${randomUUID().replaceAll('-', '')}`
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-project-delete-'))
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema} -c timezone=Asia/Shanghai` })
  const runtime = await createPostgresRuntime({ url: url!, schema })
  try {
    await pool.query(`CREATE TABLE projects (id integer PRIMARY KEY,user_id text,name text,start_date text,created_at timestamptz,version integer,deleted_at timestamptz)`)
    await pool.query(`CREATE TABLE files (user_id text,display_name text,ext text,space text,project_id integer,workspace_directory_id integer,stage_name text,mind_map_id integer,path text,version integer,deleted_at timestamptz,PRIMARY KEY(user_id,path))`)
    await pool.query(`CREATE TABLE undo_operations (id text PRIMARY KEY,user_id text,undo_context_id text,group_id text,resource text,action text,target_refs json,before_state json,after_state json,actor_type text,status varchar(16),created_at timestamptz,expires_at timestamptz,undone_at timestamptz,failure_code text)`)
    await pool.query(`CREATE TABLE project_undo_journals (id uuid PRIMARY KEY,user_id text,operation_id text,before_status text,after_status text,moves json,created_at timestamptz)`)
    const file = { user_id: '11111111-1111-4111-8111-111111111111', display_name: '文档', ext: 'txt', space: 'project', project_id: 1, workspace_directory_id: null, stage_name: null, mind_map_id: null, path: '11111111-1111-4111-8111-111111111111/项目文件/2026/01/项目 #1/文档.txt', version: 2, size: '4B', size_bytes: 4, mime_type: 'text/plain', img_width: null, img_height: null, deleted_at: '2026-01-02T00:00:00Z' } satisfies ProjectTrashFile
    const originalPath = file.path
    file.path = projectFileTrashKey('11111111-1111-4111-8111-111111111111', file)
    await mkdir(path.dirname(path.join(root, file.path)), { recursive: true })
    await writeFile(path.join(root, file.path), '内容')
    await pool.query(`INSERT INTO projects VALUES (1,'11111111-1111-4111-8111-111111111111','项目','2026-01-01',now(),2,$1)`, [file.deleted_at])
    await pool.query(`INSERT INTO files VALUES ('11111111-1111-4111-8111-111111111111','文档','txt','project',1,NULL,NULL,NULL,$1,2,$2)`, [file.path, file.deleted_at])
    const before = { items: { 'project:1': { version: 1 }, [`file:${originalPath}`]: { path: originalPath, version: 1 } } }
    const after = { items: { 'project:1': { version: 2, deleted_at: file.deleted_at }, [`file:${originalPath}`]: { path: file.path, version: 2, deleted_at: file.deleted_at } } }
    await pool.query(`INSERT INTO undo_operations VALUES ('op','11111111-1111-4111-8111-111111111111','ctx','g','projects','delete','[]',$1::json,$2::json,'web','active',now(),now()+interval '1 day',NULL,NULL)`, [JSON.stringify(before), JSON.stringify(after)])
    const service = createHostCoreUndoOperations(pool, createRuntimeUndoTransactionPort(runtime), async () => {}, { renameDirectory: createLocalProjectDirectoryRenamer(root), trash: createLocalProjectTrashStorage(root) })
    await assert.rejects(() => service.apply('22222222-2222-4222-8222-222222222222', 'ctx', 'op', 'undo'))
    await service.apply('11111111-1111-4111-8111-111111111111', 'ctx', 'op', 'undo')
    const restored = (await pool.query('SELECT path,deleted_at FROM files WHERE user_id=$1', [file.user_id])).rows[0]
    assert.equal(restored.deleted_at, null)
    assert.equal(await readFile(path.join(root, restored.path), 'utf8'), '内容')
    await service.apply('11111111-1111-4111-8111-111111111111', 'ctx', 'op', 'redo')
    const deleted = (await pool.query('SELECT path,deleted_at FROM files WHERE user_id=$1', [file.user_id])).rows[0]
    assert.ok(deleted.deleted_at)
    assert.equal(await readFile(path.join(root, deleted.path), 'utf8'), '内容')
  } finally {
    await runtime.close()
    await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin.end()
    await rm(root, { recursive: true, force: true })
  }
})
