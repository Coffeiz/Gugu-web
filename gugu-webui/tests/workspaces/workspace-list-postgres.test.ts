import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import { createPostgresWorkspaceLister } from '../../src/domains/workspaces/persistence/workspace-list.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const ownerId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'
const otherOwnerId = 'ad0902a0-c899-44ee-b180-d54eb04e4604'

test('PostgreSQL workspace list returns owner rows, disabled items, per-owner session counts and runtime flags', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => {
  const schema = `gugu_workspace_list_${randomUUID().replaceAll('-', '')}`
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
        enabled boolean NOT NULL,
        is_default boolean NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      )
    `)
    await pool.query(`
      CREATE TABLE conversation_sessions (
        id integer PRIMARY KEY,
        user_id uuid NOT NULL,
        workspace_id integer
      )
    `)
    await pool.query('CREATE TABLE user_preferences (user_id uuid PRIMARY KEY, data_json text NOT NULL)')
    await pool.query(
      `INSERT INTO workspaces
         (id, user_id, name, kind, folder_id, project_id, directory_id, enabled, is_default, created_at, updated_at)
       VALUES (1, $1, '停用文件夹', 'folder', 11, NULL, NULL, false, false, $3, $3),
              (2, $1, '默认目录', 'directory', NULL, NULL, 31, true, true, $3, $4),
              (3, $2, '他人项目', 'project', NULL, 55, NULL, true, false, $3, $4)`,
      [ownerId, otherOwnerId, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'],
    )
    await pool.query(
      `INSERT INTO conversation_sessions (id, user_id, workspace_id)
       VALUES (101, $1, 1), (102, $1, 2), (103, $1, 2), (104, $2, 2)`,
      [ownerId, otherOwnerId],
    )
    await pool.query(
      `INSERT INTO user_preferences (user_id, data_json)
       VALUES ($1, $3), ($2, $4)`,
      [ownerId, otherOwnerId, JSON.stringify({
        shell_enabled: true,
        shell_system_enabled: false,
        shell_dangerous_enabled: false,
        automatic_mode_enabled: true,
      }), JSON.stringify({ shell_enabled: false, shell_system_enabled: true })],
    )

    const settings = {
      storageBackend: 'local' as const,
      shellEnabled: true,
      shellSystemEnabled: false,
      shellDangerousEnabled: true,
      automaticModeEnabled: true,
      sandboxReady: true,
      fullUserSandboxAuthorizationEnabled: true,
      terminalMode: 'pty_disabled',
    }
    const listLocal = createPostgresWorkspaceLister(pool, { readRuntimeSettings: () => settings })
    assert.deepEqual(await listLocal(ownerId), {
      globalEnabled: true,
      sandboxEnabled: true,
      systemGlobalEnabled: false,
      dangerousGlobalEnabled: true,
      automaticModeGlobalEnabled: true,
      userEnabled: true,
      userSystemEnabled: false,
      userDangerousEnabled: false,
      userAutomaticModeEnabled: true,
      filesystemAuthorizationEnabled: true,
      workspaceSupported: true,
      storageBackend: 'local',
      terminalMode: 'pty_disabled',
      terminalEntryEnabled: true,
      ptyEnabled: false,
      items: [
        {
          id: 2, name: '默认目录', kind: 'directory', folderId: null, projectId: null,
          directoryId: 31, enabled: true, isDefault: true, boundSessionCount: 2,
        },
        {
          id: 1, name: '停用文件夹', kind: 'folder', folderId: 11, projectId: null,
          directoryId: null, enabled: false, isDefault: false, boundSessionCount: 1,
        },
      ],
    })

    const ossSettings = {
      ...settings,
      storageBackend: 'oss' as const,
      shellEnabled: false,
      sandboxReady: false,
      terminalMode: 'entry_disabled',
    }
    const listOss = createPostgresWorkspaceLister(pool, { readRuntimeSettings: () => ossSettings })
    const ossResponse = await listOss(ownerId)
    assert.equal(ossResponse.workspaceSupported, false)
    assert.equal(ossResponse.storageBackend, 'oss')
    assert.equal(ossResponse.filesystemAuthorizationEnabled, false)
    assert.equal(ossResponse.userEnabled, true, 'user preference remains visible independently of global OSS support')
    assert.equal(ossResponse.sandboxEnabled, false)
    assert.equal(ossResponse.terminalEntryEnabled, false)
    assert.equal(ossResponse.ptyEnabled, false)
    assert.deepEqual(ossResponse.items, [])
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined)
    await admin.end()
  }
})
