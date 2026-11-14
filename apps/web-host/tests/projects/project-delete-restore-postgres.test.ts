import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import { createProjectTrashService } from '../../src/domains/projects/application/project-trash.js'
import { createPostgresProjectTrashRuntime } from '../../src/domains/projects/persistence/project-trash-postgres.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const ownerId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'
const otherOwnerId = 'ad0902a0-c899-44ee-b180-d54eb04e4604'

test('PostgreSQL 项目删除/恢复原子更新同批资源、Undo 和提交后事件', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => {
  const schema = `gugu_project_trash_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 })
  const published: Array<{ resource: string; operation: string }> = []
  const storage: Array<[string, number]> = []
  const stamp = new Date().toISOString()
  try {
    await pool.query(`CREATE TABLE projects (
      id serial PRIMARY KEY, user_id uuid NOT NULL, name varchar(200) NOT NULL,
      summary varchar(200), contact_name varchar(200), status varchar(20) NOT NULL,
      start_date varchar(10), deadline varchar(10), color varchar(300) NOT NULL,
      progress integer NOT NULL, stages_json text NOT NULL, current_stage varchar(100),
      priority varchar(20), version integer NOT NULL, archived boolean NOT NULL,
      done_at timestamptz, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
      deleted_at timestamptz
    )`)
    await pool.query(`CREATE TABLE folders (
      id serial PRIMARY KEY, user_id uuid NOT NULL, project_id integer, workspace_directory_id integer,
      parent_id integer, name varchar(200) NOT NULL, version integer NOT NULL, deleted_at timestamptz
    )`)
    await pool.query(`CREATE TABLE files (
      id serial PRIMARY KEY, user_id uuid NOT NULL, display_name varchar(300) NOT NULL,
      ext varchar(20) NOT NULL, space varchar(20) NOT NULL, project_id integer, folder_id integer,
      workspace_directory_id integer, stage_name varchar(100), mind_map_id integer,
      storage_key varchar(500) NOT NULL, version integer NOT NULL, size varchar(50),
      size_bytes bigint NOT NULL, mime_type varchar(200), img_width integer, img_height integer,
      deleted_at timestamptz
    )`)
    await pool.query(`CREATE TABLE calendar_events (
      id serial PRIMARY KEY, user_id uuid NOT NULL, title varchar(300) NOT NULL,
      date varchar(10) NOT NULL, time varchar(5), end_time varchar(5), type varchar(50) NOT NULL,
      contact_name varchar(200), project_id integer, description text, version integer NOT NULL,
      deleted_at timestamptz
    )`)
    await pool.query(`CREATE TABLE scheduled_tasks (
      id serial PRIMARY KEY, user_id uuid, event_id integer, enabled boolean NOT NULL,
      name varchar(100) NOT NULL, payload text NOT NULL, cron varchar(60) NOT NULL,
      schedule_kind varchar(16) NOT NULL, start_at timestamptz, reminder_lead_minutes integer,
      channels varchar(40) NOT NULL, delivery_targets jsonb
    )`)
    await pool.query(`CREATE TABLE project_file_counts (project_id integer PRIMARY KEY, file_count bigint NOT NULL)`)
    await pool.query(`CREATE TABLE undo_operations (
      id varchar(80) PRIMARY KEY, user_id uuid NOT NULL, undo_context_id varchar(128) NOT NULL,
      group_id varchar(80) NOT NULL, resource varchar(32) NOT NULL, action varchar(32) NOT NULL,
      target_refs json NOT NULL, before_state json NOT NULL, after_state json NOT NULL,
      base_versions json NOT NULL, artifact_refs json NOT NULL, actor_type varchar(32) NOT NULL,
      status varchar(24) NOT NULL, created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
      undone_at timestamptz, failure_code varchar(80)
    )`)
    const projectRows = await pool.query<{ id: number }>(
      `INSERT INTO projects (user_id, name, status, start_date, color, progress, stages_json,
         version, archived, created_at, updated_at)
       VALUES ($1, 'PG 回归项目', 'pending', '2026-11-01', 'lavender', 0, '[]', 3, FALSE, $2, $2)
       RETURNING id`, [ownerId, stamp],
    )
    const projectId = projectRows.rows[0]!.id
    await pool.query('INSERT INTO folders (id, user_id, project_id, name, version) VALUES (31, $1, $2, \'文档\', 2)', [ownerId, projectId])
    await pool.query(
      `INSERT INTO files (id, user_id, display_name, ext, space, project_id, folder_id, storage_key,
         version, size, size_bytes, mime_type)
       VALUES (41, $1, '计划', 'md', 'project', $2, 31, $3, 4, '8', 8, 'text/markdown')`,
      [ownerId, projectId, `${ownerId}/项目文件/2026/11/PG 回归项目 #${projectId}/文档/计划.md`],
    )
    await pool.query(
      `INSERT INTO calendar_events (id, user_id, title, date, type, project_id, version)
       VALUES (51, $1, '交付', '2026-11-15', 'deadline', $2, 5)`, [ownerId, projectId],
    )
    await pool.query(
      `INSERT INTO scheduled_tasks (id, user_id, event_id, enabled, name, payload, cron, schedule_kind, channels)
       VALUES (61, $1, 51, TRUE, '交付提醒', '提醒', '0 9 15 11 *', 'cron', 'chat')`, [ownerId],
    )
    await pool.query('INSERT INTO project_file_counts (project_id, file_count) VALUES ($1, 1)', [projectId])
    await pool.query(
      `INSERT INTO undo_operations
         (id, user_id, undo_context_id, group_id, resource, action, target_refs, before_state,
          after_state, base_versions, artifact_refs, actor_type, status, created_at, expires_at)
       VALUES ('redo-branch', $1, 'tab-trash', 'old-group', 'projects', 'delete', '[]', '{}', '{}', '{}',
               '{}', 'web', 'undone', $2, $2)`, [ownerId, stamp],
    )

    const runtime = createPostgresProjectTrashRuntime(pool, async (event) => {
      const projectState = await pool.query('SELECT deleted_at FROM projects WHERE id = $1', [projectId])
      assert.equal(projectState.rowCount, 1, '事件发送时 project 必须已提交')
      if (event.operation === 'delete') assert.ok(projectState.rows[0]!.deleted_at)
      if (event.operation === 'create') assert.equal(projectState.rows[0]!.deleted_at, null)
      published.push({ resource: event.resource, operation: event.operation })
    })
    const trash = createProjectTrashService(runtime, {
      async moveToTrash(owner, file) {
        storage.push(['trash', file.id])
        return { storageKey: `${owner}/trash/2026/11/PG 回归项目 #${projectId}/文档/计划.md` }
      },
      async restoreFromTrash(_owner, file) {
        storage.push(['restore', file.id])
        return { storageKey: `${ownerId}/项目文件/2026/11/PG 回归项目 #${projectId}/文档/计划.md`, displayName: file.display_name }
      },
    })

    await trash.deleteProject(ownerId, projectId, { undoContextId: 'tab-trash', clientId: 'pg-test' })
    const deletedRows = await pool.query(
      `SELECT p.deleted_at AS project_deleted, p.version AS project_version,
              f.deleted_at AS file_deleted, f.version AS file_version, f.storage_key,
              d.deleted_at AS folder_deleted, e.deleted_at AS event_deleted, t.enabled
       FROM projects p CROSS JOIN files f CROSS JOIN folders d CROSS JOIN calendar_events e
       CROSS JOIN scheduled_tasks t WHERE p.id=$1 AND f.id=41 AND d.id=31 AND e.id=51 AND t.id=61`,
      [projectId],
    )
    const deleted = deletedRows.rows[0]!
    assert.ok(deleted.project_deleted)
    assert.equal(deleted.project_version, 4)
    assert.equal(deleted.file_deleted?.getTime(), deleted.project_deleted?.getTime())
    assert.equal(deleted.folder_deleted?.getTime(), deleted.project_deleted?.getTime())
    assert.equal(deleted.event_deleted?.getTime(), deleted.project_deleted?.getTime())
    assert.equal(deleted.file_version, 5)
    assert.equal(deleted.enabled, false)
    assert.match(deleted.storage_key, /\/trash\//)
    const undo = await pool.query(
      `SELECT resource, action, actor_type, target_refs, before_state, after_state,
      status, created_at, expires_at FROM undo_operations WHERE undo_context_id='tab-trash' AND status='active'`,
    )
    assert.equal(undo.rowCount, 1)
    assert.deepEqual(undo.rows[0]!.target_refs.map((ref: any) => `${ref.kind}:${ref.id}`).sort(),
      ['event:51', 'file:41', 'folder:31', `project:${projectId}`, 'task:61'])
    assert.equal(undo.rows[0]!.resource, 'projects')
    assert.equal(undo.rows[0]!.action, 'delete')
    assert.equal(undo.rows[0]!.actor_type, 'web')
    assert.equal(undo.rows[0]!.status, 'active')
    const days = (new Date(undo.rows[0]!.expires_at).getTime() - new Date(undo.rows[0]!.created_at).getTime()) / 86_400_000
    assert.ok(days >= 29.99 && days <= 30.01)
    const branch = await pool.query('SELECT status, failure_code FROM undo_operations WHERE id=$1', ['redo-branch'])
    assert.deepEqual(branch.rows[0], { status: 'expired', failure_code: 'redo_cleared_by_new_operation' })

    const restored = await trash.restoreProject(ownerId, projectId, { clientId: 'pg-restore' })
    assert.equal((restored as any).id, projectId)
    const activeRows = await pool.query(
      `SELECT p.deleted_at AS project_deleted, p.version AS project_version,
              f.deleted_at AS file_deleted, f.version AS file_version, d.deleted_at AS folder_deleted,
              e.deleted_at AS event_deleted, t.enabled, f.storage_key
       FROM projects p CROSS JOIN files f CROSS JOIN folders d CROSS JOIN calendar_events e
       CROSS JOIN scheduled_tasks t WHERE p.id=$1 AND f.id=41 AND d.id=31 AND e.id=51 AND t.id=61`,
      [projectId],
    )
    const active = activeRows.rows[0]!
    assert.equal(active.project_deleted, null)
    assert.equal(active.project_version, 5)
    assert.equal(active.file_deleted, null)
    assert.equal(active.file_version, 6)
    assert.equal(active.folder_deleted, null)
    assert.equal(active.event_deleted, null)
    assert.equal(active.enabled, true)
    assert.ok(!String(active.storage_key).includes('/trash/'))
    await assert.rejects(trash.deleteProject(otherOwnerId, projectId), { code: 'not_found' })
    assert.deepEqual(published.map(({ resource, operation }) => [resource, operation]), [
      ['projects', 'delete'], ['files', 'delete'], ['calendar', 'delete'], ['scheduled_tasks', 'update'],
      ['projects', 'create'], ['files', 'create'], ['calendar', 'create'], ['scheduled_tasks', 'update'],
    ])
    assert.deepEqual(storage, [['trash', 41], ['restore', 41]])
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined)
    await admin.end()
  }
})
