import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import { createPostgresProjectTrashPathMetadataReader } from '../../src/modules/projects/lifecycle/storage.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const ownerId = '00000000-0000-4000-8000-000000000041'
const otherOwnerId = '00000000-0000-4000-8000-000000000042'

test('PostgreSQL project trash path metadata restores scoped roots without a folders table', {
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
    await pool.query('INSERT INTO projects VALUES (17, $1, $2, NULL, $3, $4)', [ownerId, '项目', '2026-01-02T03:04:05Z', '2026-11-01T00:00:00Z'])
    await pool.query('INSERT INTO workspace_directories VALUES (27, $1, $2, NULL), (28, $1, $3, $4)', [ownerId, 'workspace-q1', 'workspace-deleted', '2026-11-01T00:00:00Z'])
    await pool.query('INSERT INTO mind_maps VALUES (9, $1, $2, $3)', [ownerId, '思维图', '2026-11-01T00:00:00Z'])
    const reader = createPostgresProjectTrashPathMetadataReader(pool)

    assert.deepEqual(await reader.getOwnedProject(ownerId, 17), {
      name: '项目', startDate: null, createdAt: '2026-01-02T03:04:05.000Z',
    })
    assert.equal(await reader.getOwnedProject(otherOwnerId, 17), null)
    assert.deepEqual(await reader.getOwnedWorkspaceDirectory(ownerId, 28), {
      directoryName: 'workspace-deleted', deletedAt: '2026-11-01T00:00:00.000Z',
    })
    assert.deepEqual(await reader.getOwnedMindMap(ownerId, 9), { title: '思维图' })
    assert.equal((await pool.query("SELECT to_regclass('folders') AS folders")).rows[0]?.folders, null)
  } finally {
    await pool.end()
    await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await adminPool.end()
  }
})
