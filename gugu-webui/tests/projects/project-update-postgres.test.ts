import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import { createProjectUpdater } from '../../src/domains/projects/application/project-update.js'
import { createPostgresProjectUpdateRuntime } from '../../src/domains/projects/persistence/project-update-postgres.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const ownerId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'
const otherOwnerId = 'ad0902a0-c899-44ee-b180-d54eb04e4604'

test('PostgreSQL 项目更新按 owner/version CAS，事务内更新目录键和 Undo，提交后发布事件', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => {
  const schema = `gugu_project_update_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 })
  const events: unknown[] = []
  const renames: unknown[] = []
  try {
    await pool.query(`
      CREATE TABLE projects (
        id serial PRIMARY KEY, user_id uuid NOT NULL, name varchar(200) NOT NULL,
        summary varchar(200), contact_name varchar(200), status varchar(20) NOT NULL,
        start_date varchar(10), deadline varchar(10), color varchar(300) NOT NULL,
        progress integer NOT NULL, stages_json text NOT NULL, current_stage varchar(100),
        priority varchar(20), version integer NOT NULL, archived boolean NOT NULL,
        done_at timestamptz, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
        deleted_at timestamptz
      )
    `)
    await pool.query(`CREATE TABLE files (
      id serial PRIMARY KEY, user_id uuid NOT NULL, project_id integer, storage_key text NOT NULL
    )`)
    await pool.query('CREATE TABLE project_file_counts (project_id integer PRIMARY KEY, file_count integer NOT NULL)')
    await pool.query(`
      CREATE TABLE undo_operations (
        id varchar(80) PRIMARY KEY, user_id uuid NOT NULL, undo_context_id varchar(128) NOT NULL,
        group_id varchar(80) NOT NULL, resource varchar(32) NOT NULL, action varchar(32) NOT NULL,
        target_refs json NOT NULL, before_state json NOT NULL, after_state json NOT NULL,
        base_versions json NOT NULL, artifact_refs json NOT NULL, actor_type varchar(32) NOT NULL,
        status varchar(24) NOT NULL, created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
        undone_at timestamptz, failure_code varchar(80)
      )
    `)
    const inserted = await pool.query<{ id: number }>(
      `INSERT INTO projects (
        user_id, name, contact_name, status, start_date, deadline, color, progress,
        stages_json, current_stage, version, archived, created_at, updated_at
      ) VALUES ($1, '旧项目', NULL, 'pending', '2026-11-01', '2026-12-01',
        'linear-gradient(135deg,#7b7fb2,#c4afc8)', 0,
        '[{"key":"s0","label":"准备","todos":[]},{"key":"s1","label":"交付","todos":[]}]',
        's0', 7, FALSE, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z') RETURNING id`,
      [ownerId],
    )
    const projectId = inserted.rows[0]!.id
    const oldPrefix = `${ownerId}/项目文件/2026/11/旧项目 #${projectId}`
    await pool.query('INSERT INTO files (user_id, project_id, storage_key) VALUES ($1, $2, $3)', [
      ownerId, projectId, `${oldPrefix}/资料.txt`,
    ])
    await pool.query('INSERT INTO project_file_counts (project_id, file_count) VALUES ($1, 1)', [projectId])
    const runtime = createPostgresProjectUpdateRuntime(
      pool,
      async (_owner, oldPath, newPath) => { renames.push([oldPath, newPath]) },
      async (event) => {
        const committed = await pool.query('SELECT version FROM projects WHERE id = $1', [event.entityId])
        assert.equal(committed.rows[0]?.version, 8, '更新事件必须在项目事务提交后发布')
        events.push(event)
      },
    )
    const update = createProjectUpdater(runtime)
    const result = await update(ownerId, projectId, { version: 7, name: '新项目', currentStage: 's1', status: 'done' }, {
      undoContextId: 'tab-update', clientId: 'web-client',
    })

    assert.equal(result.name, '新项目')
    assert.equal(result.currentStage, 's1')
    assert.equal(result.version, 8)
    assert.equal(result.fileCount, 1)
    assert.match(String(result.updatedAt), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/)
    assert.deepEqual(renames, [[oldPrefix, `${ownerId}/项目文件/2026/11/新项目 #${projectId}`]])
    assert.equal(events.length, 1)
    const file = await pool.query('SELECT storage_key FROM files WHERE project_id = $1', [projectId])
    assert.equal(file.rows[0]?.storage_key, `${ownerId}/项目文件/2026/11/新项目 #${projectId}/资料.txt`)
    const undo = await pool.query('SELECT * FROM undo_operations WHERE undo_context_id = $1', ['tab-update'])
    assert.equal(undo.rowCount, 1)
    assert.equal(undo.rows[0]!.resource, 'projects')
    assert.equal(undo.rows[0]!.action, 'update')
    assert.equal(undo.rows[0]!.actor_type, 'web')
    assert.equal(undo.rows[0]!.before_state.items[`project:${projectId}`].version, 7)
    assert.equal(undo.rows[0]!.after_state.items[`project:${projectId}`].version, 8)

    await assert.rejects(update(ownerId, projectId, { version: 7, name: '陈旧写入' }), { code: 'conflict' })
    await assert.rejects(update(otherOwnerId, projectId, { version: 8, name: '越权' }), { code: 'not_found' })
    assert.equal(events.length, 1)
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined)
    await admin.end()
  }
})
