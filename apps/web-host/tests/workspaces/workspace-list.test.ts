import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool } from 'pg'
import { createPostgresWorkspaceLister } from '../../src/domains/workspaces/persistence/workspace-list.js'

const ownerId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'

function recordingPool(rows: Array<{ rows: unknown[]; rowCount: number }>) {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const pool = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), values })
      const result = rows[calls.length - 1]
      if (!result) throw new Error('unexpected workspace query')
      return result
    },
  } as unknown as Pool
  return { pool, calls }
}

test('workspace list projects owner data, disabled rows and Python preference defaults', async () => {
  const db = recordingPool([
    { rows: [{ data_json: JSON.stringify({ shell_enabled: true, automatic_mode_enabled: true }) }], rowCount: 1 },
    { rows: [
      {
        id: 2, name: '默认目录', kind: 'directory', folder_id: null, project_id: null,
        directory_id: 31, enabled: true, is_default: true,
      },
      {
        id: 1, name: '停用项目', kind: 'project', folder_id: null, project_id: 9,
        directory_id: null, enabled: false, is_default: false,
      },
    ], rowCount: 2 },
    { rows: [{ workspace_id: 2, count: '2' }, { workspace_id: 1, count: '1' }], rowCount: 2 },
  ])
  const list = createPostgresWorkspaceLister(db.pool, {
    readRuntimeSettings: () => ({
      shellEnabled: true,
      shellSystemEnabled: false,
      shellDangerousEnabled: true,
      automaticModeEnabled: true,
      sandboxReady: false,
      fullUserSandboxAuthorizationEnabled: false,
      terminalMode: 'auto',
    }),
  })

  assert.deepEqual(await list(ownerId), {
    globalEnabled: true,
    sandboxEnabled: false,
    systemGlobalEnabled: false,
    dangerousGlobalEnabled: true,
    automaticModeGlobalEnabled: true,
    userEnabled: true,
    userSystemEnabled: false,
    userDangerousEnabled: true,
    userAutomaticModeEnabled: true,
    filesystemAuthorizationEnabled: false,
    workspaceSupported: true,
    storageBackend: 'local',
    terminalMode: 'auto',
    terminalEntryEnabled: false,
    ptyEnabled: false,
    items: [
      {
        id: 2, name: '默认目录', kind: 'directory', folderId: null, projectId: null,
        directoryId: 31, enabled: true, isDefault: true, boundSessionCount: 2,
      },
      {
        id: 1, name: '停用项目', kind: 'project', folderId: null, projectId: 9,
        directoryId: null, enabled: false, isDefault: false, boundSessionCount: 1,
      },
    ],
  })
  assert.equal(db.calls.length, 3)
  assert.ok(db.calls.every((call) => call.values?.[0] === ownerId))
  assert.match(db.calls[1]!.sql, /WHERE user_id = \$1 ORDER BY updated_at DESC/)
  assert.match(db.calls[2]!.sql, /WHERE user_id = \$1 AND workspace_id IS NOT NULL/)
})

test('workspace list falls back to Python shell defaults for malformed preference JSON', async () => {
  const db = recordingPool([
    { rows: [{ data_json: '{invalid json' }], rowCount: 1 },
    { rows: [], rowCount: 0 },
    { rows: [], rowCount: 0 },
  ])
  const list = createPostgresWorkspaceLister(db.pool, {
    readRuntimeSettings: () => ({
      shellEnabled: true,
      shellSystemEnabled: true,
      shellDangerousEnabled: false,
      automaticModeEnabled: false,
      sandboxReady: true,
      fullUserSandboxAuthorizationEnabled: true,
      terminalMode: 'entry_disabled',
    }),
  })

  const result = await list(ownerId)
  assert.equal(result.userEnabled, true)
  assert.equal(result.userSystemEnabled, false)
  assert.equal(result.userDangerousEnabled, true)
  assert.equal(result.userAutomaticModeEnabled, false)
  assert.equal(result.terminalEntryEnabled, false)
  assert.equal(result.ptyEnabled, false)
  assert.deepEqual(result.items, [])
})
