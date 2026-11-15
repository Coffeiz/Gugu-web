import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'vitest'
import pg from 'pg'
import { sql } from 'kysely'
import { createDeferredProjectCreator, createProjectCreator, ProjectCreateIdempotencyConflictError, ProjectCreateValidationError } from '../../../src/projects/project-create.js'
import { createKyselyProjectCreateRuntime } from '../../../src/projects/create-store.js'
import { createPostgresRuntime } from '../../../src/data/postgres.js'
import { tablesSql } from '../../../src/data/schema.js'

const url = process.env.GUGU_CORE_TEST_POSTGRES_URL
if (!url) throw new Error('项目创建回归必须显式提供隔离 PostgreSQL')
test('项目创建在 PostgreSQL 同事务记录撤销，并发幂等与失败回滚', async () => {
  const schema = `gugu_project_create_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Client({ connectionString: url })
  await admin.connect()
  await admin.query(`CREATE SCHEMA "${schema}"`)
  await admin.query(`SET search_path TO "${schema}"`)
  const definition = tablesSql('postgres')
  await admin.query(`${definition.projects}; ${definition.undo}`)
  const runtime = await createPostgresRuntime({ url: url!, schema })
  try {
    const owner = randomUUID(), events: unknown[] = []
    const create = createProjectCreator(createKyselyProjectCreateRuntime({
      db: runtime.db, backend: 'postgres',
      async publishProjectCreated(event) { events.push(event) },
    }))
    const results = await Promise.all([1, 2].map(() => create(owner, { name: '测试项目' }, { idempotencyKey: 'request', undoContextId: 'tab' })))
    assert.deepEqual(results.map(result => result.created).sort(), [false, true])
    assert.equal(results[0]!.project.id, results[1]!.project.id)
    assert.equal(events.length, 1)
    assert.equal((await runtime.db.selectFrom('undo_operations').selectAll().execute()).length, 1)
    await create(randomUUID(), { name: '另一用户项目' }, { undoContextId: 'tab' })
    await runtime.db.updateTable('undo_operations').set({ status: 'undone' }).execute()
    await create(owner, { name: '新项目' }, { undoContextId: 'tab' })
    const undo = await runtime.db.selectFrom('undo_operations').select(['status', 'failure_code']).execute()
    assert.equal(undo.filter(row => row.status === 'expired' && row.failure_code === 'redo_cleared_by_new_operation').length, 1)
    assert.equal(undo.filter(row => row.status === 'active').length, 1)
    assert.equal(undo.filter(row => row.status === 'undone').length, 1)
    const colorOptions = { idempotencyKey: 'color', selectUnusedColor: true, includeAgentFields: true }
    const colored = await create(owner, { name: '自动配色', priority: 'high' }, { ...colorOptions, undoContextId: 'agent' })
    assert.notEqual(colored.project.color, results[0]!.project.color)
    assert.equal((await create(owner, { name: '自动配色', priority: 'high' }, { ...colorOptions, undoContextId: 'agent' })).project.color, colored.project.color)
    const agentUndo = await runtime.db.selectFrom('undo_operations').select('after_state').where('undo_context_id', '=', 'agent').executeTakeFirstOrThrow()
    const afterState = agentUndo.after_state as unknown as { items: Record<string, { priority: string }> }
    assert.equal(afterState.items[`project:${colored.project.id}`]!.priority, 'high')
    assert.equal((events.at(-1) as { payload: { priority: string } }).payload.priority, 'high')
    const deferred = createDeferredProjectCreator(createKyselyProjectCreateRuntime({ db: runtime.db, backend: 'postgres', async publishProjectCreated() {} }))
    const raw = { project_name: '延迟项目', deadline: '2026-12-01' }
    const firstDeferred = await deferred(owner, () => ({ name: raw.project_name, deadline: raw.deadline }), { idempotencyKey: 'deferred', fingerprintPayload: raw, publishEvent: false })
    const replayDeferred = await deferred(owner, () => { throw new Error('重放不应校验') }, { idempotencyKey: 'deferred', fingerprintPayload: raw })
    assert.equal(replayDeferred.project.id, firstDeferred.project.id)
    await assert.rejects(deferred(owner, () => { throw new Error('冲突不应校验') }, { idempotencyKey: 'deferred', fingerprintPayload: { ...raw, deadline: '2026-02-31' } }), ProjectCreateIdempotencyConflictError)
    await assert.rejects(deferred(owner, () => ({ name: '新项目', deadline: '2026-02-31' }), { idempotencyKey: 'new-invalid', fingerprintPayload: { deadline: '2026-02-31' } }), ProjectCreateValidationError)
    await sql`DROP TABLE undo_operations`.execute(runtime.db)
    await assert.rejects(create(owner, { name: '应回滚' }, { undoContextId: 'tab' }))
    assert.equal((await runtime.db.selectFrom('projects').selectAll().execute()).length, 5)
    assert.equal(events.length, 4)
  } finally {
    await runtime.close()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})
