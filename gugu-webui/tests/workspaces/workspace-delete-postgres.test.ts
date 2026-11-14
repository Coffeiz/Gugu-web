import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import { CoreError } from '@gugu/core'
import { createPostgresWorkspaceDeleter } from '../../src/domains/workspaces/persistence/workspace-delete.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const ownerId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'
const otherOwnerId = 'ad0902a0-c899-44ee-b180-d54eb04e4604'

test('PostgreSQL 删除工作区仅清理归属绑定、停用普通任务且保留底层项目', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => {
  const schema = `gugu_workspace_delete_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 3 })
  try {
    await pool.query(`
      CREATE TABLE workspaces (
        id integer PRIMARY KEY,
        user_id uuid NOT NULL,
        name varchar(200) NOT NULL,
        kind varchar(20) NOT NULL,
        folder_id integer,
        project_id integer,
        directory_id integer,
        enabled boolean NOT NULL DEFAULT true,
        is_default boolean NOT NULL DEFAULT false
      )
    `)
    await pool.query(`
      CREATE TABLE conversation_sessions (
        id integer PRIMARY KEY,
        user_id uuid NOT NULL,
        workspace_id integer REFERENCES workspaces(id) ON DELETE SET NULL
      )
    `)
    await pool.query(`
      CREATE TABLE scheduled_tasks (
        id integer PRIMARY KEY,
        user_id uuid,
        event_id integer,
        workspace_id integer REFERENCES workspaces(id) ON DELETE SET NULL,
        enabled boolean NOT NULL DEFAULT true
      )
    `)
    await pool.query(`
      CREATE TABLE file_sync_bindings (
        id integer PRIMARY KEY,
        user_id uuid NOT NULL,
        workspace_id integer REFERENCES workspaces(id) ON DELETE CASCADE,
        source varchar(24) NOT NULL
      )
    `)
    await pool.query(`
      CREATE TABLE terminal_sessions (
        id varchar(80) PRIMARY KEY,
        owner_id uuid NOT NULL,
        workspace_id integer REFERENCES workspaces(id) ON DELETE SET NULL
      )
    `)
    await pool.query('CREATE TABLE projects (id integer PRIMARY KEY, user_id uuid NOT NULL, name text NOT NULL)')
    await pool.query(
      "INSERT INTO workspaces (id, user_id, name, kind, project_id) VALUES (41, $1, '工作区', 'project', 9)",
      [ownerId],
    )
    await pool.query(
      "INSERT INTO projects (id, user_id, name) VALUES (9, $1, '保留项目')",
      [ownerId],
    )
    await pool.query(
      `INSERT INTO conversation_sessions (id, user_id, workspace_id)
       VALUES (101, $1, 41), (102, $2, 41)`,
      [ownerId, otherOwnerId],
    )
    await pool.query(
      `INSERT INTO scheduled_tasks (id, user_id, event_id, workspace_id, enabled)
       VALUES (201, $1, NULL, 41, true), (202, $1, 7, 41, true), (203, $2, NULL, 41, true)`,
      [ownerId, otherOwnerId],
    )
    await pool.query(
      `INSERT INTO file_sync_bindings (id, user_id, workspace_id, source) VALUES (301, $1, 41, 'local_directory')`,
      [ownerId],
    )
    await pool.query(
      `INSERT INTO terminal_sessions (id, owner_id, workspace_id) VALUES ('terminal-1', $1, 41)`,
      [ownerId],
    )

    const remove = createPostgresWorkspaceDeleter(pool)
    await assert.rejects(remove(otherOwnerId, 41), (error: unknown) =>
      error instanceof CoreError && error.code === 'not_found',
    )
    assert.equal((await pool.query('SELECT id FROM workspaces WHERE id = 41')).rowCount, 1)
    assert.deepEqual(await remove(ownerId, 41), { ok: true, workspaceId: 41 })

    assert.deepEqual((await pool.query('SELECT workspace_id FROM conversation_sessions ORDER BY id')).rows, [
      { workspace_id: null }, { workspace_id: null },
    ])
    assert.deepEqual((await pool.query('SELECT event_id, workspace_id, enabled FROM scheduled_tasks ORDER BY id')).rows, [
      { event_id: null, workspace_id: null, enabled: false },
      { event_id: 7, workspace_id: null, enabled: true },
      { event_id: null, workspace_id: null, enabled: true },
    ])
    assert.deepEqual((await pool.query('SELECT id, name FROM projects')).rows, [{ id: 9, name: '保留项目' }])
    assert.equal((await pool.query('SELECT id FROM file_sync_bindings WHERE id = 301')).rowCount, 0)
    assert.deepEqual((await pool.query('SELECT workspace_id FROM terminal_sessions WHERE id = $1', ['terminal-1'])).rows, [
      { workspace_id: null },
    ])
    assert.equal((await pool.query('SELECT id FROM workspaces WHERE id = 41')).rowCount, 0)
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined)
    await admin.end()
  }
})
