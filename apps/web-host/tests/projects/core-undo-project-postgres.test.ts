import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Pool } from 'pg'
import { projectResponse, type ProjectRecord } from '@gugu/core'
import { createHostCoreUndoOperations } from '../../src/domains/undo/persistence/core-operations.js'
import { createPostgresRuntime } from '@gugu/core/data'
import { createRuntimeUndoTransactionPort } from '@gugu/core/undo'
import { directoryPort } from './fixtures/directory-port.js'
import { createLocalProjectTrashStorage } from '../../src/domains/projects/persistence/project-trash-storage.js'
import { recoverProjectUndoJournal } from '../../src/domains/undo/persistence/project-journal.js'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL
test('Core PG 引擎与显式目录端口协调改名、锁和未知提交 journal', { skip: !url }, async () => {
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

    await pool.query(`CREATE TABLE files (id integer PRIMARY KEY,user_id text,project_id integer,storage_key text)`)
    await pool.query(`CREATE TABLE undo_operations (id text PRIMARY KEY,user_id text,undo_context_id text,group_id text,resource text,action text,target_refs json,before_state json,after_state json,actor_type text,status varchar(16),created_at timestamptz,expires_at timestamptz,undone_at timestamptz,failure_code text)`)
    await pool.query(`CREATE TABLE project_undo_journals (id uuid PRIMARY KEY,user_id text,operation_id text,before_status text,after_status text,moves json,created_at timestamptz)`)
    const oldKey = '11111111-1111-4111-8111-111111111111/项目文件/2026/01/旧 #1', newKey = '11111111-1111-4111-8111-111111111111/项目文件/2026/01/新 #1'
    const directories = directoryPort(newKey, '内容')
    await pool.query(`INSERT INTO projects (id,user_id,name,start_date,created_at,version,stages_json) VALUES (1,'11111111-1111-4111-8111-111111111111','新','2026-01-01','2026-01-01T00:30:00.123000+08:00',2,'[]')`)
    await pool.query(`INSERT INTO files VALUES (1,'11111111-1111-4111-8111-111111111111',1,$1)`, [`${newKey}/a.txt`])
    await pool.query(`INSERT INTO undo_operations VALUES ('op','11111111-1111-4111-8111-111111111111','ctx','g','projects','update','[]',$1::json,$2::json,'web','active',now(),now()+interval '1 day',NULL,NULL)`, [JSON.stringify({ items: { 'project:1': { name: '旧', stages: [] } } }), JSON.stringify({ items: { 'project:1': { name: '新', stages: [], version: 2 } } })])
    const notifications: Record<string, unknown>[] = []
    const reread = async () => projectResponse((await pool.query(`SELECT *, contact_name AS client,
      created_at::text AS created_at,updated_at::text AS updated_at,done_at::text AS done_at,
      deleted_at::text AS deleted_at FROM projects WHERE id=1`)).rows[0] as ProjectRecord, 0)
    let notificationStarted!: () => void, resumeNotification!: () => void
    const enteredNotification = new Promise<void>(resolve => { notificationStarted = resolve })
    const notificationGate = new Promise<void>(resolve => { resumeNotification = resolve })
    const service = createHostCoreUndoOperations(pool, createRuntimeUndoTransactionPort(runtime), async (_owner, event) => {
      notifications.push(event)
      if (notifications.length === 1) { notificationStarted(); await notificationGate }
    }, { renameDirectory: directories.renameDirectory, trash: createLocalProjectTrashStorage(root) })
    const lock = await pool.connect()
    await lock.query("SELECT pg_advisory_lock(hashtext('gugu-project-undo-journal'))")
    let settled = false
    const pending = service.apply('11111111-1111-4111-8111-111111111111', 'ctx', 'op', 'undo').finally(() => { settled = true })
    try {
      await new Promise(resolve => setTimeout(resolve, 150))
      assert.equal(settled, false)
      const probe = await pool.connect()
      try {
        await probe.query('BEGIN')
        await probe.query("SELECT id FROM undo_operations WHERE id='op' FOR UPDATE NOWAIT")
        assert.equal(Number((await probe.query('SELECT count(*) AS count FROM project_undo_journals')).rows[0].count), 0)
        await probe.query('ROLLBACK')
      } finally { probe.release() }
    } finally {
      await lock.query("SELECT pg_advisory_unlock(hashtext('gugu-project-undo-journal'))")
      lock.release()
    }
    await enteredNotification
    const duringPublish = await pool.connect()
    try {
      assert.equal((await duringPublish.query("SELECT pg_try_advisory_lock(hashtext('gugu-project-undo-journal')) AS acquired")).rows[0].acquired, true)
      assert.equal(Number((await duringPublish.query('SELECT count(*) AS count FROM project_undo_journals')).rows[0].count), 0)
      await duringPublish.query("SELECT pg_advisory_unlock(hashtext('gugu-project-undo-journal'))")
    } finally { duringPublish.release(); resumeNotification() }
    const undone = await pending as { events: Record<string, unknown>[] }
    assert.deepEqual(undone.events, [{ resource: 'projects', operation: 'update', entity_ids: [1], origin: 'undo:op' }])
    const afterUndo = await reread()
    assert.equal(afterUndo.name, '旧')
    assert.equal(afterUndo.createdAt, '2025-12-31')
    assert.equal(afterUndo.updatedAt, '2025-12-31T16:30:00.123456+00:00')
    assert.equal(afterUndo.doneAt, null)
    assert.equal(afterUndo.deletedAt, null)
    assert.equal(directories.contents(oldKey), '内容')
    assert.equal((await pool.query('SELECT storage_key FROM files')).rows[0].storage_key, `${oldKey}/a.txt`)
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
    await assert.rejects(service.apply('22222222-2222-4222-8222-222222222222', 'ctx', 'op', 'undo'), (error: any) => error.code === 'undo.not_found')
    const noStorage = createHostCoreUndoOperations(pool, createRuntimeUndoTransactionPort(runtime), async () => {})
    await assert.rejects(noStorage.apply('11111111-1111-4111-8111-111111111111', 'ctx', 'op', 'undo'), (error: any) => error.code === 'undo.unsupported')
    for (const [id, snapshot, expected] of [['conflict', { 'project:1': { version: 99 } }, 'conflicted'], ['unsupported', { 'unknown:1': {} }, 'failed']] as const) {
      await pool.query(`INSERT INTO undo_operations VALUES ($1,'11111111-1111-4111-8111-111111111111','ctx','g','projects','update','[]','{}'::json,$2::json,'web','active',now(),now()+interval '1 day',NULL,NULL)`, [id, JSON.stringify({ items: snapshot })])
      await assert.rejects(service.apply('11111111-1111-4111-8111-111111111111', 'ctx', id, 'undo'))
      assert.equal((await pool.query('SELECT status FROM undo_operations WHERE id=$1', [id])).rows[0].status, expected)
      assert.equal(Number((await pool.query('SELECT count(*) AS count FROM project_undo_journals')).rows[0].count), 0)
    }
    // 模拟服务器已提交但客户端未收到 COMMIT 确认，禁止补偿并保留 journal。
    await pool.query(`INSERT INTO undo_operations VALUES ('unknown','11111111-1111-4111-8111-111111111111','ctx','g','projects','update','[]',$1::json,$2::json,'web','active',now(),now()+interval '1 day',NULL,NULL)`, [JSON.stringify({ items: { 'project:1': { name: '旧', stages: [] } } }), JSON.stringify({ items: { 'project:1': { name: '新', stages: [], version: 4 } } })])
    const basePort = createRuntimeUndoTransactionPort(runtime)
    const uncertainPort = { ...basePort, async transaction<T>(work: Parameters<typeof basePort.transaction<T>>[0]): Promise<T> {
      await basePort.transaction(work)
      throw new Error('提交结果未知')
    } }
    const uncertain = createHostCoreUndoOperations(pool, uncertainPort, async () => { throw new Error('不应发送通知') }, { renameDirectory: directories.renameDirectory, trash: createLocalProjectTrashStorage(root) })
    await assert.rejects(uncertain.apply('11111111-1111-4111-8111-111111111111', 'ctx', 'unknown', 'undo'), /提交结果未知/)
    assert.equal((await pool.query("SELECT status FROM undo_operations WHERE id='unknown'")).rows[0].status, 'undone')
    assert.equal(directories.contents(oldKey), '内容')
    assert.equal(Number((await pool.query('SELECT count(*) AS count FROM project_undo_journals')).rows[0].count), 1)
    assert.equal(notifications.length, 2)
    await recoverProjectUndoJournal(pool, directories.journal)
    assert.equal(Number((await pool.query('SELECT count(*) AS count FROM project_undo_journals')).rows[0].count), 0)
    await service.apply('11111111-1111-4111-8111-111111111111', 'ctx', 'unknown', 'redo')
    await pool.query(`ALTER TABLE projects ADD CONSTRAINT reject_name CHECK (name <> '失败')`)
    await pool.query(`INSERT INTO undo_operations VALUES ('fail','11111111-1111-4111-8111-111111111111','ctx','g','projects','update','[]',$1::json,$2::json,'web','active',now(),now()+interval '1 day',NULL,NULL)`, [JSON.stringify({ items: { 'project:1': { name: '失败', stages: [] } } }), JSON.stringify({ items: { 'project:1': { name: '新', stages: [], version: 6 } } })])
    await assert.rejects(() => service.apply('11111111-1111-4111-8111-111111111111', 'ctx', 'fail', 'undo'))
    assert.equal(directories.contents(newKey), '内容')
    assert.equal((await pool.query('SELECT storage_key FROM files')).rows[0].storage_key, `${newKey}/a.txt`)
  } finally {
    await runtime.close()
    await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin.end()
    await rm(root, { recursive: true, force: true })
  }
})
