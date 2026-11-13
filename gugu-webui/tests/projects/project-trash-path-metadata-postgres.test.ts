import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import { createPostgresProjectTrashPathMetadataReader } from '../../src/domains/projects/persistence/project-trash-path-metadata-postgres.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const ownerId = '00000000-0000-4000-8000-000000000041'
const otherOwnerId = '00000000-0000-4000-8000-000000000042'

test('PostgreSQL project trash path metadata follows owner and complete folder-chain scope', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => {
  const schema = `gugu_project_path_${randomUUID().replaceAll('-', '')}`
  const adminPool = new Pool({ connectionString: databaseUrl, max: 1 })
  await adminPool.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  try {
    await pool.query('CREATE TABLE projects (id integer PRIMARY KEY, user_id uuid NOT NULL, name text NOT NULL, start_date text, created_at timestamptz NOT NULL, deleted_at timestamptz)')
    await pool.query('CREATE TABLE workspace_directories (id integer PRIMARY KEY, user_id uuid NOT NULL, directory_name text NOT NULL, deleted_at timestamptz)')
    await pool.query('CREATE TABLE mind_maps (id integer PRIMARY KEY, user_id uuid NOT NULL, title text NOT NULL, deleted_at timestamptz)')
    await pool.query('CREATE TABLE folders (id integer PRIMARY KEY, user_id uuid NOT NULL, project_id integer, workspace_directory_id integer, parent_id integer, name text NOT NULL)')
    await pool.query('INSERT INTO projects VALUES (17, $1, $2, NULL, $3, $4)', [ownerId, '项目', '2026-01-02T03:04:05Z', '2026-11-01T00:00:00Z'])
    await pool.query('INSERT INTO workspace_directories VALUES (27, $1, $2, NULL), (28, $1, $3, $4)', [ownerId, 'workspace-q1', 'workspace-deleted', '2026-11-01T00:00:00Z'])
    await pool.query('INSERT INTO mind_maps VALUES (9, $1, $2, $3)', [ownerId, '思维图', '2026-11-01T00:00:00Z'])
    await pool.query('INSERT INTO folders VALUES (31, $1, 17, NULL, NULL, $2), (32, $1, 17, NULL, 31, $3), (33, $4, 17, NULL, NULL, $5), (34, $1, 17, NULL, 999, $6)', [ownerId, '资料', '会议', otherOwnerId, '外人', '断链'])
    const reader = createPostgresProjectTrashPathMetadataReader(pool)

    assert.deepEqual(await reader.getOwnedProject(ownerId, 17), {
      name: '项目', startDate: null, createdAt: '2026-01-02T03:04:05.000Z',
    })
    assert.equal(await reader.getOwnedProject(otherOwnerId, 17), null)
    assert.deepEqual(await reader.getOwnedWorkspaceDirectory(ownerId, 28), {
      directoryName: 'workspace-deleted', deletedAt: '2026-11-01T00:00:00.000Z',
    })
    assert.deepEqual(await reader.getOwnedMindMap(ownerId, 9), { title: '思维图' })
    assert.equal(await reader.resolveOwnedFolderPath(ownerId, 32, 17, null), '资料/会议')
    assert.equal(await reader.resolveOwnedFolderPath(ownerId, 33, 17, null), null)
    assert.equal(await reader.resolveOwnedFolderPath(ownerId, 34, 17, null), null)
  } finally {
    await pool.end()
    await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await adminPool.end()
  }
})
