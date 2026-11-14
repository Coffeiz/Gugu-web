import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import { createPostgresWorkspaceUpdater, WorkspaceUpdateError } from '../../src/domains/workspaces/persistence/workspace-update.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const ownerId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'
const otherOwnerId = 'ad0902a0-c899-44ee-b180-d54eb04e4604'

test('PATCH workspace 保持 owner、directory path、绑定名称、enabled 与错误语义', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => {
  const schema = `gugu_workspace_update_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 })
  try {
    await pool.query(`
      CREATE TABLE workspace_directories (
        id serial PRIMARY KEY,
        user_id uuid NOT NULL,
        name varchar(200) NOT NULL,
        directory_name varchar(200) NOT NULL,
        is_default boolean NOT NULL DEFAULT false,
        is_system boolean NOT NULL DEFAULT false,
        deleted_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)
    await pool.query(`
      CREATE UNIQUE INDEX uq_workspace_directory_display_name
      ON workspace_directories (user_id, name) WHERE deleted_at IS NULL
    `)
    await pool.query(`
      CREATE TABLE workspaces (
        id serial PRIMARY KEY,
        user_id uuid NOT NULL,
        name varchar(200) NOT NULL,
        kind varchar(20) NOT NULL DEFAULT 'folder',
        folder_id integer,
        project_id integer,
        directory_id integer,
        enabled boolean NOT NULL DEFAULT true,
        is_default boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)
    await pool.query(`
      CREATE TABLE conversation_sessions (
        id serial PRIMARY KEY,
        user_id uuid NOT NULL,
        workspace_id integer
      )
    `)
    await pool.query(
      `INSERT INTO workspace_directories
         (id, user_id, name, directory_name, is_system)
       VALUES (31, $1, 'Old Display', 'frozen-physical-segment', false),
              (32, $1, 'Taken Display', 'taken-physical-segment', false),
              (33, $1, 'System Directory', 'system-physical-segment', true),
              (34, $2, 'Other Owner Directory', 'other-owner-segment', false)`,
      [ownerId, otherOwnerId],
    )
    await pool.query(
      `INSERT INTO workspaces (id, user_id, name, kind, directory_id, enabled)
       VALUES (41, $1, 'Old Display', 'directory', 31, true),
              (42, $1, 'Old Display', 'directory', 31, false),
              (43, $1, 'System Directory', 'directory', 33, true),
              (44, $2, 'Other Owner Directory', 'directory', 34, true),
              (45, $1, 'Project Workspace', 'project', NULL, true)`,
      [ownerId, otherOwnerId],
    )
    await pool.query(
      'INSERT INTO conversation_sessions (user_id, workspace_id) VALUES ($1, 41), ($1, 41), ($1, 42)',
      [ownerId],
    )

    const update = createPostgresWorkspaceUpdater(pool)
    const result = await update(ownerId, 41, { name: '  New Display  ', enabled: false })
    assert.deepEqual(result, {
      id: 41,
      name: 'New Display',
      kind: 'directory',
      folderId: null,
      projectId: null,
      directoryId: 31,
      enabled: false,
      isDefault: false,
      boundSessionCount: 2,
    })

    const physicalDirectory = await pool.query(
      'SELECT name, directory_name FROM workspace_directories WHERE id = 31 AND user_id = $1',
      [ownerId],
    )
    assert.deepEqual(physicalDirectory.rows[0], {
      name: 'New Display', directory_name: 'frozen-physical-segment',
    })
    const bindings = await pool.query(
      'SELECT id, name, enabled FROM workspaces WHERE user_id = $1 AND directory_id = 31 ORDER BY id',
      [ownerId],
    )
    assert.deepEqual(bindings.rows, [
      { id: 41, name: 'New Display', enabled: false },
      { id: 42, name: 'New Display', enabled: false },
    ])

    await assert.rejects(update(ownerId, 41, { name: 'Taken Display' }), (error: unknown) => {
      assert.ok(error instanceof WorkspaceUpdateError)
      assert.equal(error.statusCode, 400)
      assert.match(error.message, /已存在/)
      return true
    })
    await assert.rejects(update(ownerId, 41, { name: 'default' }), { statusCode: 400 })
    await assert.rejects(update(ownerId, 43, { name: 'Renamed System' }), { statusCode: 400 })
    await assert.rejects(update(ownerId, 41, { name: '   ' }), { statusCode: 400 })
    await assert.rejects(update(ownerId, 44, { enabled: false }), { statusCode: 404 })
    await assert.rejects(update(ownerId, 999, { enabled: false }), { statusCode: 404 })
    const disabledProjectWorkspace = await update(ownerId, 45, { enabled: false })
    assert.equal(disabledProjectWorkspace.enabled, false)

    const noChange = await update(ownerId, 41, {})
    assert.equal(noChange.name, 'New Display')
    assert.equal(noChange.enabled, false)
    assert.equal(noChange.boundSessionCount, 2)
    assert.equal((await pool.query('SELECT name FROM workspace_directories WHERE id = 32')).rows[0]!.name, 'Taken Display')
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined)
    await admin.end()
  }
})
