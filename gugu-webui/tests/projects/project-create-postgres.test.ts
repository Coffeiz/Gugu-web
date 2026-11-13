import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import { createAgentProjectTool } from '../../src/domains/agent-sessions/tools/agent-project-tool.js'
import { createProjectCreator } from '../../src/domains/projects/application/project-create.js'
import { createPostgresProjectCreateRuntime } from '../../src/domains/projects/persistence/project-create-postgres.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const ownerId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'
const otherOwnerId = 'ad0902a0-c899-44ee-b180-d54eb04e4604'

test('PostgreSQL 项目创建在单事务内持久化项目与 Undo，并支持 owner 级幂等和并发重放', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => {
  const schema = `gugu_project_create_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 })
  const events: unknown[] = []
  try {
    await pool.query(`
      CREATE TABLE projects (
        id serial PRIMARY KEY,
        user_id uuid NOT NULL,
        name varchar(200) NOT NULL,
        summary varchar(200),
        contact_name varchar(200),
        status varchar(20) NOT NULL,
        start_date varchar(10),
        deadline varchar(10),
        color varchar(300) NOT NULL,
        progress integer NOT NULL,
        stages_json text NOT NULL,
        current_stage varchar(100),
        priority varchar(20),
        version integer NOT NULL,
        archived boolean NOT NULL,
        done_at timestamptz,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        deleted_at timestamptz,
        idempotency_key varchar(64),
        idempotency_fingerprint varchar(64),
        CONSTRAINT uq_projects_user_idempotency_key UNIQUE (user_id, idempotency_key)
      )
    `)
    await pool.query(`
      CREATE TABLE undo_operations (
        id varchar(80) PRIMARY KEY,
        user_id uuid NOT NULL,
        undo_context_id varchar(128) NOT NULL,
        group_id varchar(80) NOT NULL,
        resource varchar(32) NOT NULL,
        action varchar(32) NOT NULL,
        target_refs json NOT NULL,
        before_state json NOT NULL,
        after_state json NOT NULL,
        base_versions json NOT NULL,
        artifact_refs json NOT NULL,
        actor_type varchar(32) NOT NULL DEFAULT 'web',
        status varchar(24) NOT NULL DEFAULT 'active',
        created_at timestamptz NOT NULL,
        undone_at timestamptz,
        expires_at timestamptz,
        failure_code varchar(80)
      )
    `)

    const runtime = createPostgresProjectCreateRuntime(pool, async (event) => {
      const visible = await pool.query('SELECT id FROM projects WHERE id = $1', [event.entityId])
      assert.equal(visible.rowCount, 1, '项目事件应在事务提交后发布')
      events.push(event)
    })
    const create = createProjectCreator(runtime)
    const now = new Date().toISOString()
    await pool.query(
      `INSERT INTO undo_operations
         (id, user_id, undo_context_id, group_id, resource, action, target_refs,
          before_state, after_state, base_versions, artifact_refs, actor_type, status,
          created_at, expires_at)
       VALUES ('old-undone', $1, 'tab-1', 'old-group', 'projects', 'create', '[]',
               '{}', '{}', '{}', '{}', 'web', 'undone', $2, $2)`,
      [ownerId, now],
    )

    const input = { name: 'PG 项目', stages: [{ key: 's0', label: '准备', todos: [] }] }
    const options = { idempotencyKey: 'pg-create-key', undoContextId: 'tab-1', clientId: 'web-client' }
    const [first, concurrent] = await Promise.all([
      create(ownerId, input, options),
      create(ownerId, input, options),
    ])
    assert.equal(first.project.id, concurrent.project.id)
    assert.equal([first, concurrent].filter((result) => result.created).length, 1)
    assert.equal(events.length, 1)
    const firstEvent = events[0] as { payload: { createdAt: string; updatedAt: string } }
    assert.match(firstEvent.payload.createdAt, /^\d{4}-\d{2}-\d{2}$/)
    assert.match(firstEvent.payload.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/)

    const projects = await pool.query('SELECT * FROM projects WHERE user_id = $1', [ownerId])
    assert.equal(projects.rowCount, 1)
    assert.equal(projects.rows[0]!.name, 'PG 项目')
    assert.equal(projects.rows[0]!.contact_name, null)
    assert.deepEqual(JSON.parse(projects.rows[0]!.stages_json), [
      { key: 's0', label: '准备', todos: [] },
    ])
    assert.match(projects.rows[0]!.idempotency_key, /^[0-9a-f]{64}$/)
    assert.match(projects.rows[0]!.idempotency_fingerprint, /^[0-9a-f]{64}$/)

    const undo = await pool.query(
      `SELECT * FROM undo_operations WHERE user_id = $1 AND undo_context_id = 'tab-1'
       AND id <> 'old-undone'`,
      [ownerId],
    )
    assert.equal(undo.rowCount, 1)
    assert.equal(undo.rows[0]!.resource, 'projects')
    assert.equal(undo.rows[0]!.action, 'create')
    assert.equal(undo.rows[0]!.actor_type, 'web')
    assert.equal(undo.rows[0]!.status, 'active')
    assert.deepEqual(undo.rows[0]!.target_refs, [{ kind: 'project', id: first.project.id }])
    assert.deepEqual(undo.rows[0]!.before_state, { items: {} })
    assert.equal(undo.rows[0]!.after_state.items[`project:${first.project.id}`].name, 'PG 项目')
    const retentionDays = (new Date(undo.rows[0]!.expires_at).getTime() - new Date(undo.rows[0]!.created_at).getTime()) / 86_400_000
    assert.ok(retentionDays >= 29.99 && retentionDays <= 30.01)

    const branch = await pool.query("SELECT status, failure_code FROM undo_operations WHERE id = 'old-undone'")
    assert.deepEqual(branch.rows[0], { status: 'expired', failure_code: 'redo_cleared_by_new_operation' })

    const replay = await create(ownerId, input, options)
    assert.equal(replay.project.id, first.project.id)
    assert.equal(replay.created, false)
    await assert.rejects(
      create(ownerId, { name: '不同内容', stages: [{ key: 's0', label: '准备', todos: [] }] }, options),
      { code: 'conflict' },
    )
    const otherOwner = await create(otherOwnerId, input, options)
    assert.notEqual(otherOwner.project.id, first.project.id)
    assert.equal(events.length, 2)

    const createAgentProject = createAgentProjectTool(runtime)
    const agentArgs = {
      project_name: 'Agent PG 项目', summary: 'Agent 摘要', priority: 'HIGH', color: 'sage',
      start_date: '2026-11-01', deadline: '2026-12-01', stages: ['准备', '交付'],
    }
    const agentDispatch = { sessionId: 42, toolCallId: 'agent-pg-call' }
    const [agentFirst, agentReplay] = await Promise.all([
      createAgentProject(ownerId, agentArgs, agentDispatch),
      createAgentProject(ownerId, agentArgs, agentDispatch),
    ])
    assert.equal(agentFirst.project_id, agentReplay.project_id)
    assert.equal([agentFirst, agentReplay].filter(result => !result.idempotent_replay).length, 1)
    assert.equal(events.length, 2, 'Agent 创建沿用 Python 行为，不发送 Web 项目事件')
    const agentProject = await pool.query(
      'SELECT summary, priority FROM projects WHERE id = $1', [agentFirst.project_id],
    )
    assert.deepEqual(agentProject.rows[0], { summary: 'Agent 摘要', priority: 'high' })
    const agentUndo = await pool.query(
      `SELECT id FROM undo_operations WHERE user_id = $1 AND undo_context_id = 'agent-session:42'`,
      [ownerId],
    )
    assert.equal(agentUndo.rowCount, 0, 'Agent 创建不写入 Web Undo 记录')

    await pool.query("UPDATE undo_operations SET status = 'expired' WHERE status = 'active'")
    await pool.query("ALTER TABLE undo_operations ADD CONSTRAINT reject_active_undo CHECK (status <> 'active')")
    await assert.rejects(create(ownerId, { name: 'Undo 回滚验证' }, {
      idempotencyKey: 'undo-rollback-key', undoContextId: 'tab-rollback',
    }))
    const rolledBackProject = await pool.query(
      `SELECT id FROM projects WHERE user_id = $1 AND name = 'Undo 回滚验证'`,
      [ownerId],
    )
    assert.equal(rolledBackProject.rowCount, 0, 'Undo 写入失败时项目插入必须回滚')
    assert.equal(events.length, 2, '回滚的项目不应发布事件')
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined)
    await admin.end()
  }
})
