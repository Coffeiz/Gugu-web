import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Pool } from 'pg'
import test from 'node:test'
import { createPostgresRuntime, tablesSql } from '@gugu/core/data'
import { createConfirmationGate, createProjectDeleteTool, type ConfirmationIntent } from '@gugu/core/tools'
import { createProjectTrashService } from '@gugu/core/project-trash'
import { createBorrowedPostgresProjectTrashTransaction, createPostgresProjectTrashRuntime } from '../../src/modules/projects/lifecycle/store.js'
import { createLocalProjectTrashStorage } from '../../src/modules/projects/lifecycle/storage.js'
import { createPostgresProjectDeleteJournal } from '../../src/modules/undo/journal.js'
import { createLocalProjectUndoJournalStorage } from '../../src/modules/undo/journal.js'
import { createAuthorizedWebAgentProductionRagRunPorts } from '../../src/modules/agent/rag/production.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const ownerId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'
const otherOwnerId = 'ad0902a0-c899-44ee-b180-d54eb04e4604'

test('PostgreSQL 项目删除/恢复在无 files 与 folders 表时原子更新关联资源和 Undo', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => {
  const schema = `gugu_project_trash_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema} -c timezone=Asia/Shanghai`, max: 4 })
  const core = await createPostgresRuntime({ url: databaseUrl!, schema })
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-project-trash-tool-'))
  const published: Array<{ resource: string; operation: string }> = []
  const storage: Array<[string, number]> = []
  const projectPayloads: unknown[] = []
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
    await pool.query(`CREATE TABLE rag_index_jobs(id bigserial PRIMARY KEY,user_id uuid NOT NULL,source_type text NOT NULL,source_id text NOT NULL,pending_source_ids json,version text NOT NULL,operation text NOT NULL,status text NOT NULL,generation int NOT NULL,completed_generation int NOT NULL,attempts int NOT NULL,next_attempt_at timestamptz,lease_until timestamptz,last_error_code text,last_started_at timestamptz,last_succeeded_at timestamptz,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,UNIQUE(user_id,source_type))`)
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

    await pool.query("UPDATE projects SET created_at='2026-11-14T00:30:00+08:00' WHERE id=$1", [projectId])
    await pool.query(`CREATE FUNCTION fixed_restore_times() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.updated_at := '2026-11-14T00:30:00.123000+08:00'; RETURN NEW; END $$;
      CREATE TRIGGER fixed_restore_times BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION fixed_restore_times()`)
    const runtime = createPostgresProjectTrashRuntime(pool, async (event) => {
      const projectState = await pool.query('SELECT deleted_at FROM projects WHERE id = $1', [projectId])
      assert.equal(projectState.rowCount, 1, '事件发送时 project 必须已提交')
      if (event.operation === 'delete') assert.ok(projectState.rows[0]!.deleted_at)
      if (event.operation === 'create') assert.equal(projectState.rows[0]!.deleted_at, null)
      published.push({ resource: event.resource, operation: event.operation })
      if (event.resource === 'projects' && event.payload !== undefined) projectPayloads.push(event.payload)
    }, async () => 1)
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
              e.deleted_at AS event_deleted, t.enabled
       FROM projects p CROSS JOIN calendar_events e
       CROSS JOIN scheduled_tasks t WHERE p.id=$1 AND e.id=51 AND t.id=61`,
      [projectId],
    )
    const deleted = deletedRows.rows[0]!
    assert.ok(deleted.project_deleted)
    assert.equal(deleted.project_version, 4)
    assert.equal(deleted.event_deleted?.getTime(), deleted.project_deleted?.getTime())
    assert.equal(deleted.enabled, false)
    assert.deepEqual((await pool.query(`SELECT source_id,pending_source_ids,generation FROM rag_index_jobs WHERE user_id=$1 AND source_type='scheduled_task'`, [ownerId])).rows[0], { source_id: '61', pending_source_ids: ['61'], generation: 1 })
    const undo = await pool.query(
      `SELECT resource, action, actor_type, target_refs, before_state, after_state,
      status, created_at, expires_at FROM undo_operations WHERE undo_context_id='tab-trash' AND status='active'`,
    )
    assert.equal(undo.rowCount, 1)
    assert.deepEqual(undo.rows[0]!.target_refs.map((ref: any) => `${ref.kind}:${ref.id}`).sort(),
      ['event:51', `project:${projectId}`, 'task:61'])
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
    assert.deepEqual(projectPayloads, [restored])
    assert.equal((restored as any).createdAt, '2026-11-13')
    assert.equal((restored as any).updatedAt, '2026-11-13T16:30:00.123000+00:00')
    assert.equal((restored as any).doneAt, null)
    assert.equal((restored as any).deletedAt, null)
    assert.equal((await pool.query('SELECT updated_at::text FROM projects WHERE id=$1', [projectId])).rows[0].updated_at, '2026-11-14 00:30:00.123+08')
    const activeRows = await pool.query(
      `SELECT p.deleted_at AS project_deleted, p.version AS project_version,
              e.deleted_at AS event_deleted, t.enabled
       FROM projects p CROSS JOIN calendar_events e
       CROSS JOIN scheduled_tasks t WHERE p.id=$1 AND e.id=51 AND t.id=61`,
      [projectId],
    )
    const active = activeRows.rows[0]!
    assert.equal(active.project_deleted, null)
    assert.equal(active.project_version, 5)
    assert.equal(active.event_deleted, null)
    assert.equal(active.enabled, true)
    assert.deepEqual((await pool.query(`SELECT source_id,pending_source_ids,generation FROM rag_index_jobs WHERE user_id=$1 AND source_type='scheduled_task'`, [ownerId])).rows[0], { source_id: '61', pending_source_ids: ['61'], generation: 2 })
    await assert.rejects(trash.deleteProject(otherOwnerId, projectId), { code: 'not_found' })
    assert.deepEqual(published.map(({ resource, operation }) => [resource, operation]), [
      ['projects', 'delete'], ['calendar', 'delete'], ['scheduled_tasks', 'update'],
      ['projects', 'create'], ['calendar', 'create'], ['scheduled_tasks', 'update'],
    ])
    assert.deepEqual(storage, [])

    await pool.query(`${tablesSql('postgres').receipts};
      CREATE TABLE project_undo_journals(id uuid PRIMARY KEY,user_id uuid,operation_id varchar(64),before_status varchar(16),
        after_status varchar(16),moves json,created_at timestamptz,UNIQUE(user_id,operation_id));
      CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid,active_run_id text);
      CREATE TABLE agent_run_dispatch(user_id uuid,session_id integer,run_id text,state text,token text,fence bigint,lease_expires_at timestamptz)`)
    const identity = { ownerId, sessionId: '1', runId: 'synthetic-project-delete' }
    const lease = { identity, token: 'synthetic-lease', fence: 1, mode: 'start' as const, cancelRequested: false,
      input: { userMessageId: 1, locale: null, origin: null, accessVersion: 'a'.repeat(64), v: 2 as const, source: 'web' as const } }
    await pool.query('INSERT INTO conversation_sessions VALUES (1,$1,$2)', [ownerId, identity.runId])
    await pool.query("INSERT INTO agent_run_dispatch VALUES ($1,1,$2,'selected',$3,1,CURRENT_TIMESTAMP+interval '5 minutes')", [ownerId, identity.runId, lease.token])
    const originalKey = `${ownerId}/项目文件/2026/11/PG 回归项目 #${projectId}/文档/计划.md`
    await mkdir(path.dirname(path.join(root, originalKey)), { recursive: true })
    await writeFile(path.join(root, originalKey), '实际文件内容')
    let intent: ConfirmationIntent | undefined, publishedAgent = 0
    const gate = createConfirmationGate({
      now: () => 0,
      async authorize() { return 'synthetic-epoch' },
      async prepare(binding, snapshot) {
        assert.equal(snapshot.targetIds?.file_id?.length ?? 0, 0)
        intent = { schemaVersion: 2, binding, intentId: 'intent', interactionId: 'confirm', operationId: 'operation',
          purpose: 'action', action: 'delete_project', authorizationEpoch: 'synthetic-epoch', expiresAt: 60_000,
          targetsDigest: snapshot.targetsDigest, versionsDigest: snapshot.versionsDigest }
        return intent
      },
      async inspect() { return intent ?? null },
      async load(_binding, receipt) {
        if (!intent || receipt.receiptId !== 'approved') return null
        return { intent, receipt: { schemaVersion: 2, binding: intent.binding, intentId: intent.intentId, interactionId: intent.interactionId,
          receiptId: receipt.receiptId, purpose: intent.purpose, action: intent.action, expiresAt: intent.expiresAt, status: 'approved' as const } }
      },
    }, { purpose: 'action', action: 'delete_project' })
    const local = createLocalProjectUndoJournalStorage(root)
    const makeRegistry = () => createAuthorizedWebAgentProductionRagRunPorts({
      core, pool, lease, storageRoot: root, enabled: () => true,
      selection: { modelIdentity: 'synthetic', contextScopeKey: lease.input.accessVersion, contextPolicy: { loadOwnerContext: true, memoryEnabled: false } },
      projectDelete: createProjectDeleteTool(core, {
        ...createPostgresProjectDeleteJournal(pool, local), storage: createLocalProjectTrashStorage(root),
        transactionPort: createBorrowedPostgresProjectTrashTransaction,
        async publish() {
          const lock = await pool.query("SELECT pg_try_advisory_xact_lock(hashtext('gugu-project-undo-journal')) AS acquired")
          assert.equal(lock.rows[0].acquired, true)
          publishedAgent++
        },
      }, { gate, async claim() { return true } }),
    }).toolRegistry
    const registry = makeRegistry()
    const call = { id: 'delete', name: 'delete_project', input: { project_ids: [projectId] } }
    const scope = { identity, roundId: '1', resolution: null, signal: new AbortController().signal,
      async execute(): Promise<never> { throw new Error('不调用沙盒') } }
    assert.equal((await registry.tools.dispatch(call, scope)).kind, 'waiting')
    assert.equal(await local.exists(ownerId, originalKey), true)
    const resume = { ...scope, resolution: { interactionId: 'confirm', receiptId: 'approved', status: 'confirmed' as const, value: {} } }
    await pool.query("ALTER TABLE rag_index_jobs ADD CONSTRAINT reject_calendar_job CHECK(source_type <> 'calendar')")
    assert.equal((await registry.tools.dispatch(call, resume)).kind, 'unknown')
    assert.equal(await readFile(path.join(root, originalKey), 'utf8'), '实际文件内容')
    assert.equal((await pool.query('SELECT deleted_at FROM projects WHERE id=$1', [projectId])).rows[0].deleted_at, null)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_undo_journals')).rows[0].n, 0)
    await pool.query('ALTER TABLE rag_index_jobs DROP CONSTRAINT reject_calendar_job')
    const result = await registry.tools.dispatch(call, resume)
    assert.ok(result.kind === 'completed' && result.successful && result.mutated, JSON.stringify(result))
    assert.equal(await readFile(path.join(root, originalKey), 'utf8'), '实际文件内容')
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_undo_journals')).rows[0].n, 0)
    assert.deepEqual(await makeRegistry().tools.dispatch(call, resume), { ...result, mutated: false })
    assert.equal(publishedAgent, 3)
    const jobs = await pool.query('SELECT source_type FROM rag_index_jobs WHERE user_id=$1 ORDER BY source_type', [ownerId])
    assert.deepEqual(jobs.rows.map(row => row.source_type), ['calendar', 'project', 'scheduled_task'])
  } finally {
    await rm(root, { recursive: true, force: true })
    await core.close()
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined)
    await admin.end()
  }
})
