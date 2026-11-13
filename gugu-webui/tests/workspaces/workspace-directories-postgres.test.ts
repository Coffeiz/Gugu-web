import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import test from 'node:test'
import { CoreError } from '@gugu/core'
import { createPostgresWorkspaceDirectoryOperations } from '../../src/domains/workspaces/persistence/workspace-directories.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const userId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'
const otherUserId = '3c01ac44-6576-41f0-9d99-3d2f0cb456ef'

test('PostgreSQL Workspace Directory CRUD 保持归属、计数、绑定和删除事务/文件顺序', {
  skip: !databaseUrl,
}, async () => {
  const schema = `gugu_workspace_directories_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  const root = mkdtempSync(join(tmpdir(), 'gugu-workspace-directory-'))
  let pool: Pool | undefined
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
    await pool.query(`
      CREATE TABLE users (id uuid PRIMARY KEY);
      CREATE TABLE workspace_directories (
        id serial PRIMARY KEY, user_id uuid NOT NULL, name varchar(200) NOT NULL,
        directory_name varchar(200) NOT NULL, is_default boolean NOT NULL DEFAULT false,
        is_system boolean NOT NULL DEFAULT false, deleted_at timestamptz,
        created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
      );
      CREATE UNIQUE INDEX uq_workspace_directory_name ON workspace_directories(user_id,directory_name) WHERE deleted_at IS NULL;
      CREATE UNIQUE INDEX uq_workspace_directory_display_name ON workspace_directories(user_id,name) WHERE deleted_at IS NULL;
      CREATE TABLE workspaces (
        id serial PRIMARY KEY, user_id uuid NOT NULL, name text NOT NULL, kind text NOT NULL,
        directory_id integer, enabled boolean NOT NULL, is_default boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE files (
        id serial PRIMARY KEY, user_id uuid NOT NULL, workspace_directory_id integer NOT NULL,
        space text NOT NULL, folder_id integer, deleted_at timestamptz, updated_at timestamptz
      );
      CREATE TABLE folders (
        id serial PRIMARY KEY, user_id uuid NOT NULL, workspace_directory_id integer NOT NULL,
        parent_id integer, deleted_at timestamptz, updated_at timestamptz, version integer NOT NULL DEFAULT 1
      );
      CREATE TABLE conversation_sessions (id serial PRIMARY KEY, user_id uuid NOT NULL, workspace_id integer);
      CREATE TABLE scheduled_tasks (id serial PRIMARY KEY, user_id uuid, workspace_id integer, enabled boolean NOT NULL);
      CREATE TABLE terminal_sessions (
        id varchar(80) PRIMARY KEY, owner_id uuid NOT NULL, workspace_id integer,
        status text NOT NULL, closed_at timestamptz, updated_at timestamptz
      );
    `)
    await pool.query('INSERT INTO users(id) VALUES ($1), ($2)', [userId, otherUserId])

    let failTermination = false
    const terminated: string[] = []
    const prepared: string[] = []
    const operations = createPostgresWorkspaceDirectoryOperations(pool, {
      storageBackend: 'local',
      localPath: root,
      async prepareDirectoryAcl(path) {
        prepared.push(path)
        await mkdir(path, { recursive: true, mode: 0o777 })
      },
      async terminateActivePty(id) {
        terminated.push(id)
        if (failTermination) throw new Error('PTY termination failed')
      },
      now: () => new Date('2026-11-13T12:00:00.000Z'),
    })

    const created = await operations.create(userId, '  数据分析  ')
    assert.equal(created.name, '数据分析')
    assert.equal(created.directory_name, `workspace-${created.id}`)
    assert.equal(created.is_default, false)
    assert.equal(prepared.length, 2, '创建首个目录时同时准备默认根和新根')
    const defaultRows = await pool.query('SELECT name, is_default, is_system FROM workspace_directories WHERE user_id=$1 AND directory_name=$2', [userId, 'default'])
    assert.deepEqual(defaultRows.rows, [{ name: '默认工作区', is_default: true, is_system: true }])
    const userBindings = await pool.query('SELECT id, name, kind, directory_id, is_default FROM workspaces WHERE user_id=$1 ORDER BY id', [userId])
    assert.deepEqual(userBindings.rows, [
      { id: 1, name: '默认工作区', kind: 'directory', directory_id: 1, is_default: false },
      { id: 2, name: '数据分析', kind: 'directory', directory_id: created.id, is_default: false },
    ])

    const bindingId = userBindings.rows[1]!.id
    await pool.query('INSERT INTO files(user_id,workspace_directory_id,space,folder_id) VALUES ($1,$2,\'workspace\',NULL),($1,$2,\'workspace\',40),($1,$2,\'workspace\',NULL)', [userId, created.id])
    await pool.query('UPDATE files SET deleted_at=now() WHERE id=(SELECT max(id) FROM files)')
    await pool.query('INSERT INTO folders(user_id,workspace_directory_id,parent_id) VALUES ($1,$2,NULL),($1,$2,41),($1,$2,NULL)', [userId, created.id])
    await pool.query('UPDATE folders SET deleted_at=now() WHERE id=(SELECT max(id) FROM folders)')
    await pool.query('INSERT INTO conversation_sessions(user_id,workspace_id) VALUES ($1,$2)', [userId, bindingId])
    await pool.query('INSERT INTO scheduled_tasks(user_id,workspace_id,enabled) VALUES ($1,$2,true)', [userId, bindingId])
    await pool.query('INSERT INTO terminal_sessions(id,owner_id,workspace_id,status) VALUES (\'pty-1\',$1,$2,\'running\')', [userId, bindingId])

    const listed = await operations.list(userId)
    assert.equal(listed.length, 2)
    const listedCreated = listed.find((item) => item.id === created.id)!
    assert.deepEqual(
      [listedCreated.file_count, listedCreated.folder_count, listedCreated.bound_session_count, listedCreated.bound_task_count],
      [1, 1, 1, 1],
    )
    assert.equal((await operations.list(otherUserId)).length, 0)
    await assert.rejects(operations.previewDelete(otherUserId, created.id), (error: unknown) =>
      error instanceof CoreError && error.code === 'not_found',
    )

    const renamed = await operations.update(userId, created.id, '数据分析二版')
    assert.equal(renamed.name, '数据分析二版')
    assert.equal(renamed.directory_name, created.directory_name)
    const renamedBinding = await pool.query('SELECT name FROM workspaces WHERE directory_id=$1', [created.id])
    assert.deepEqual(renamedBinding.rows, [{ name: '数据分析二版' }])

    const preview = await operations.previewDelete(userId, created.id)
    assert.deepEqual(
      [preview.file_count, preview.folder_count, preview.bound_session_count, preview.bound_task_count],
      [2, 2, 1, 1],
    )
    await assert.rejects(operations.delete(userId, 1), (error: unknown) =>
      error instanceof CoreError && error.code === 'conflict',
    )

    const physicalRoot = join(root, userId, 'workspace', created.directory_name)
    assert.ok(prepared.includes(physicalRoot))
    failTermination = true
    await assert.rejects(operations.delete(userId, created.id), /PTY termination failed/)
    assert.equal((await pool.query('SELECT deleted_at FROM workspace_directories WHERE id=$1', [created.id])).rows[0]!.deleted_at, null)
    assert.equal((await pool.query('SELECT workspace_id FROM conversation_sessions')).rows[0]!.workspace_id, bindingId)
    assert.equal((await pool.query('SELECT enabled FROM scheduled_tasks')).rows[0]!.enabled, true)
    assert.equal((await pool.query('SELECT closed_at FROM terminal_sessions WHERE id=\'pty-1\'')).rows[0]!.closed_at, null)
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM files WHERE deleted_at IS NOT NULL')).rows[0]!.count, 1)
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM folders WHERE deleted_at IS NOT NULL')).rows[0]!.count, 1)
    assert.ok(await stat(physicalRoot))

    failTermination = false
    const deleted = await operations.delete(userId, created.id)
    assert.deepEqual(deleted, { ok: true, workspaceDirectoryId: created.id })
    assert.deepEqual(terminated, ['pty-1', 'pty-1'])
    assert.ok((await pool.query('SELECT deleted_at FROM workspace_directories WHERE id=$1', [created.id])).rows[0]!.deleted_at)
    assert.equal((await pool.query('SELECT workspace_id FROM conversation_sessions')).rows[0]!.workspace_id, null)
    assert.deepEqual((await pool.query('SELECT workspace_id, enabled FROM scheduled_tasks')).rows[0], { workspace_id: null, enabled: false })
    assert.deepEqual((await pool.query('SELECT status, closed_at FROM terminal_sessions WHERE id=\'pty-1\'')).rows[0], {
      status: 'terminated', closed_at: new Date('2026-11-13T12:00:00.000Z'),
    })
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM files WHERE deleted_at IS NOT NULL')).rows[0]!.count, 3)
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM folders WHERE deleted_at IS NOT NULL')).rows[0]!.count, 3)
    await assert.rejects(stat(physicalRoot), { code: 'ENOENT' })
  } finally {
    await pool?.end()
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin.end()
    rmSync(root, { recursive: true, force: true })
  }
})
