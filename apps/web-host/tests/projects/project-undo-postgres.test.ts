import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Pool } from 'pg'
import { projectResponse, type ProjectRecord } from '@gugu/core'
import { createHostCoreUndoOperations } from '../../src/domains/undo/persistence/core-operations.js'
import { createPostgresRuntime } from '@gugu/core/data'
import { createRuntimeUndoTransactionPort } from '@gugu/core/undo'
import { createLocalProjectDirectoryRenamer } from '../../src/domains/projects/persistence/project-directory-storage.js'
import { createLocalProjectTrashStorage, projectFileTrashKey } from '../../src/domains/projects/persistence/project-trash-storage.js'
import type { ProjectTrashFile } from '../../src/domains/projects/application/project-trash.js'
import { recoverProjectUndoJournal, saveProjectUndoJournal } from '../../src/domains/undo/persistence/project-journal.js'
import { createLocalProjectUndoJournalStorage } from '../../src/domains/undo/persistence/project-journal-local.js'
import { directoryPort } from './fixtures/directory-port.js'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL
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
    await pool.query(`ALTER TABLE projects ADD CONSTRAINT reject_name CHECK (name <> '失败')`)
    await pool.query(`INSERT INTO undo_operations VALUES ('fail','11111111-1111-4111-8111-111111111111','ctx','g','projects','update','[]',$1::json,$2::json,'web','active',now(),now()+interval '1 day',NULL,NULL)`, [JSON.stringify({ items: { 'project:1': { name: '失败', stages: [] } } }), JSON.stringify({ items: { 'project:1': { name: '新', stages: [], version: 4 } } })])
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
    await pool.query(`CREATE TABLE files (id integer PRIMARY KEY,user_id text,display_name text,ext text,space text,project_id integer,folder_id integer,workspace_directory_id integer,stage_name text,mind_map_id integer,storage_key text,version integer,deleted_at timestamptz)`)
    await pool.query(`CREATE TABLE undo_operations (id text PRIMARY KEY,user_id text,undo_context_id text,group_id text,resource text,action text,target_refs json,before_state json,after_state json,actor_type text,status varchar(16),created_at timestamptz,expires_at timestamptz,undone_at timestamptz,failure_code text)`)
    await pool.query(`CREATE TABLE project_undo_journals (id uuid PRIMARY KEY,user_id text,operation_id text,before_status text,after_status text,moves json,created_at timestamptz)`)
    const file = { id: 2, user_id: '11111111-1111-4111-8111-111111111111', display_name: '文档', ext: 'txt', space: 'project', project_id: 1, folder_id: null, workspace_directory_id: null, stage_name: null, mind_map_id: null, storage_key: '11111111-1111-4111-8111-111111111111/项目文件/2026/01/项目 #1/文档.txt', version: 2, deleted_at: '2026-01-02T00:00:00Z' } as ProjectTrashFile
    file.storage_key = projectFileTrashKey('11111111-1111-4111-8111-111111111111', file)
    await mkdir(path.dirname(path.join(root, file.storage_key)), { recursive: true })
    await writeFile(path.join(root, file.storage_key), '内容')
    await pool.query(`INSERT INTO projects VALUES (1,'11111111-1111-4111-8111-111111111111','项目','2026-01-01',now(),2,$1)`, [file.deleted_at])
    await pool.query(`INSERT INTO files VALUES (2,'11111111-1111-4111-8111-111111111111','文档','txt','project',1,NULL,NULL,NULL,NULL,$1,2,$2)`, [file.storage_key, file.deleted_at])
    const before = { items: { 'project:1': { version: 1 }, 'file:2': { version: 1 } } }
    const after = { items: { 'project:1': { version: 2, deleted_at: file.deleted_at }, 'file:2': { version: 2, deleted_at: file.deleted_at } } }
    await pool.query(`INSERT INTO undo_operations VALUES ('op','11111111-1111-4111-8111-111111111111','ctx','g','projects','delete','[]',$1::json,$2::json,'web','active',now(),now()+interval '1 day',NULL,NULL)`, [JSON.stringify(before), JSON.stringify(after)])
    const service = createHostCoreUndoOperations(pool, createRuntimeUndoTransactionPort(runtime), async () => {}, { renameDirectory: createLocalProjectDirectoryRenamer(root), trash: createLocalProjectTrashStorage(root) })
    await assert.rejects(() => service.apply('22222222-2222-4222-8222-222222222222', 'ctx', 'op', 'undo'))
    await service.apply('11111111-1111-4111-8111-111111111111', 'ctx', 'op', 'undo')
    const restored = (await pool.query('SELECT storage_key,deleted_at FROM files WHERE id=2')).rows[0]
    assert.equal(restored.deleted_at, null)
    assert.equal(await readFile(path.join(root, restored.storage_key), 'utf8'), '内容')
    await service.apply('11111111-1111-4111-8111-111111111111', 'ctx', 'op', 'redo')
    const deleted = (await pool.query('SELECT storage_key,deleted_at FROM files WHERE id=2')).rows[0]
    assert.ok(deleted.deleted_at)
    assert.equal(await readFile(path.join(root, deleted.storage_key), 'utf8'), '内容')
  } finally {
    await runtime.close()
    await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin.end()
    await rm(root, { recursive: true, force: true })
  }
})
