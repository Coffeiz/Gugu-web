import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { test } from 'vitest'
import { sql } from 'kysely'
import { createDeferredProjectCreator, createProjectCreator, ProjectCreateIdempotencyConflictError, ProjectCreateValidationError, validateProjectCreateFields } from '../../../src/projects/project-create.js'
import { CoreError } from '../../../src/contracts/index.js'
import { createKyselyProjectCreateRuntime } from '../../../src/projects/create-store.js'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'

test('项目字段错误有独立来源，身份、幂等、取消和事务异常不被重标', async () => {
  const owner = randomUUID()
  let transactions = 0
  const transactionError = new CoreError('invalid_request', '合成事务错误')
  const create = createProjectCreator({
    async transaction() { transactions++; throw transactionError },
    async publishProjectCreated() { assert.fail('不应发布') },
    isUniqueViolation: () => false,
  })
  for (const input of [{ name: '' }, { name: '项目', deadline: '2026-02-30' }, { name: '项目', stages: '错误' }])
    await assert.rejects(create(owner, input), (error: unknown) => error instanceof ProjectCreateValidationError && error.code === 'invalid_request')
  await assert.rejects(create('bad-owner', { name: '项目' }), (error: unknown) => error instanceof CoreError && !(error instanceof ProjectCreateValidationError))
  await assert.rejects(create(owner, { name: '项目' }, { idempotencyKey: ' ' }), (error: unknown) => error instanceof CoreError && !(error instanceof ProjectCreateValidationError))
  assert.equal(transactions, 0)
  await assert.rejects(create(owner, { name: '项目' }), error => error === transactionError)
  assert.throws(() => validateProjectCreateFields(() => { throw new CoreError('invalid_request', '无效阶段') }), ProjectCreateValidationError)
  const failure = new Error('非字段故障')
  assert.throws(() => validateProjectCreateFields(() => { throw failure }), error => error === failure)
})

test('项目创建在同一 SQLite 事务记录撤销，重复请求不重发事件，撤销失败时回滚', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'gugu-create-contract-'))
  const path = join(folder, 'core.db')
  try {
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      const events: unknown[] = []
      const create = createProjectCreator(createKyselyProjectCreateRuntime({
        db: runtime.db, backend: 'sqlite',
        async publishProjectCreated(event) { events.push(event) },
      }))
      const first = await create(ownerId, { name: '测试项目' }, { idempotencyKey: 'request', undoContextId: 'tab' })
      const repeated = await create(ownerId, { name: '测试项目' }, { idempotencyKey: 'request', undoContextId: 'tab' })
      assert.equal(first.created, true)
      assert.equal(repeated.created, false)
      assert.equal(repeated.project.id, first.project.id)
      assert.equal(events.length, 1)
      await assert.rejects(create(ownerId, { name: '不同内容' }, { idempotencyKey: 'request' }),
        (error: unknown) => error instanceof ProjectCreateIdempotencyConflictError && error.code === 'conflict' && error.message === '该 Idempotency-Key 已用于不同的创建内容')
      const base = createKyselyProjectCreateRuntime({ db: runtime.db, backend: 'sqlite', async publishProjectCreated() {} })
      const unique = new Error('合成唯一约束竞争')
      let calls = 0
      const competing = createProjectCreator({ ...base, isUniqueViolation: error => error === unique,
        async transaction(work) { if (++calls === 1) throw unique; return base.transaction(work) } })
      await assert.rejects(competing(ownerId, { name: '不同内容' }, { idempotencyKey: 'request' }), ProjectCreateIdempotencyConflictError)
      const unrelated = new CoreError('conflict', '合成非幂等冲突')
      const failing = createProjectCreator({ ...base, async transaction() { throw unrelated } })
      await assert.rejects(failing(ownerId, { name: '测试项目' }), error => error === unrelated && !(error instanceof ProjectCreateIdempotencyConflictError))
      assert.equal((await runtime.db.selectFrom('undo_operations').selectAll().execute()).length, 1)
      await create(randomUUID(), { name: '另一用户项目' }, { undoContextId: 'tab' })
      await runtime.db.updateTable('undo_operations').set({ status: 'undone' }).execute()
      await create(ownerId, { name: '新项目' }, { undoContextId: 'tab' })
      const undo = await runtime.db.selectFrom('undo_operations').select(['status', 'failure_code']).orderBy('created_at').execute()
      assert.equal(undo.filter(row => row.status === 'expired' && row.failure_code === 'redo_cleared_by_new_operation').length, 1)
      assert.equal(undo.filter(row => row.status === 'active').length, 1)
      assert.equal(undo.filter(row => row.status === 'undone').length, 1)
      const colorOptions = { idempotencyKey: 'color', selectUnusedColor: true, includeAgentFields: true }
      const colored = await create(ownerId, { name: '自动配色', priority: 'high' }, { ...colorOptions, undoContextId: 'agent' })
      assert.notEqual(colored.project.color, first.project.color)
      assert.equal((await create(ownerId, { name: '自动配色', priority: 'high' }, { ...colorOptions, undoContextId: 'agent' })).project.color, colored.project.color)
      const agentUndo = await runtime.db.selectFrom('undo_operations').select('after_state').where('undo_context_id', '=', 'agent').executeTakeFirstOrThrow()
      assert.ok(typeof agentUndo.after_state === 'string')
      assert.equal(JSON.parse(agentUndo.after_state).items[`project:${colored.project.id}`].priority, 'high')
      assert.equal((events.at(-1) as { payload: { priority: string } }).payload.priority, 'high')
      const deferred = createDeferredProjectCreator(base)
      const raw = { project_name: '延迟项目', deadline: '2026-12-01' }
      let prepared = 0
      const firstDeferred = await deferred(ownerId, () => { prepared++; return { name: raw.project_name, deadline: raw.deadline } }, { idempotencyKey: 'deferred', fingerprintPayload: raw, publishEvent: false })
      const replayDeferred = await deferred(ownerId, () => { throw new Error('重放不应校验') }, { idempotencyKey: 'deferred', fingerprintPayload: raw, publishEvent: false })
      assert.equal(replayDeferred.project.id, firstDeferred.project.id)
      assert.equal(prepared, 1)
      await assert.rejects(deferred(ownerId, () => { throw new Error('冲突不应校验') }, { idempotencyKey: 'deferred', fingerprintPayload: { ...raw, deadline: '2026-02-31' } }), ProjectCreateIdempotencyConflictError)
      await assert.rejects(deferred(ownerId, () => ({ name: '新项目', deadline: '2026-02-31' }), { idempotencyKey: 'new-invalid', fingerprintPayload: { deadline: '2026-02-31' } }), ProjectCreateValidationError)
      await assert.rejects(deferred(randomUUID(), () => ({ name: '跨用户', deadline: '2026-02-31' }), { idempotencyKey: 'deferred', fingerprintPayload: raw }), ProjectCreateValidationError)
      const aborted = new AbortController(); aborted.abort()
      await assert.rejects(deferred(ownerId, () => { throw new Error('取消不应校验') }, { idempotencyKey: 'deferred', fingerprintPayload: raw, signal: aborted.signal }), { code: 'cancelled' })
      let noKeyPreparations = 0
      const noKey = () => deferred(ownerId, () => { noKeyPreparations++; return { name: '无收据项目' } }, { idempotencyKey: null, fingerprintPayload: raw, publishEvent: false })
      const noKeyFirst = await noKey(), noKeySecond = await noKey()
      assert.notEqual(noKeyFirst.project.id, noKeySecond.project.id)
      assert.equal(noKeyPreparations, 2)
      const noKeyRows = await runtime.db.selectFrom('projects').select('idempotency_key').where('name', '=', '无收据项目').execute()
      assert.deepEqual(noKeyRows.map(row => row.idempotency_key), [null, null])
      const missingKey = { fingerprintPayload: raw } as Parameters<typeof deferred>[2]
      await assert.rejects(deferred(ownerId, () => { throw new Error('缺键不应校验') }, missingKey), { code: 'invalid_request' })
      await assert.rejects(deferred(ownerId, () => { throw new Error('空键不应校验') }, { idempotencyKey: ' ', fingerprintPayload: raw }), { code: 'invalid_request' })
      await sql`DROP TABLE undo_operations`.execute(runtime.db)
      await assert.rejects(create(ownerId, { name: '应回滚' }, { undoContextId: 'tab' }))
      assert.equal((await runtime.db.selectFrom('projects').selectAll().execute()).length, 7)
      assert.equal(events.length, 4)
    } finally { await runtime.close() }
  } finally { await rm(folder, { recursive: true, force: true }) }
})

test('创建事务中取消会回滚项目和撤销，提交后取消保留结果', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'gugu-create-cancel-'))
  try {
    const path = join(folder, 'core.db')
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      const events: unknown[] = []
      const base = createKyselyProjectCreateRuntime({ db: runtime.db, backend: 'sqlite',
        async publishProjectCreated(event) { events.push(event) } })
      const cancelled = new AbortController()
      const create = createProjectCreator({ ...base, transaction: work => base.transaction(tx => work({
        ...tx, async recordUndo(record) { await tx.recordUndo(record); cancelled.abort() },
      })) })
      await assert.rejects(create(ownerId, { name: '取消项目' }, { signal: cancelled.signal, undoContextId: 'tab' }),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === 'cancelled')
      assert.equal((await runtime.db.selectFrom('projects').selectAll().execute()).length, 0)
      assert.equal((await runtime.db.selectFrom('undo_operations').selectAll().execute()).length, 0)
      assert.equal(events.length, 0)

      const afterCommit = new AbortController()
      const committedCreate = createProjectCreator({ ...base, async transaction(work) {
        const result = await base.transaction(work)
        afterCommit.abort()
        return result
      } })
      const result = await committedCreate(ownerId, { name: '已提交项目' }, { signal: afterCommit.signal, undoContextId: 'tab' })
      assert.equal(result.created, true)
      assert.equal((await runtime.db.selectFrom('projects').selectAll().execute()).length, 1)
      assert.equal((await runtime.db.selectFrom('undo_operations').selectAll().execute()).length, 1)
      assert.equal(events.length, 1)
    } finally { await runtime.close() }
  } finally { await rm(folder, { recursive: true, force: true }) }
})
