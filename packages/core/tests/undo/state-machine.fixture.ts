import assert from 'node:assert/strict'
import { sql, type Kysely } from 'kysely'
import { type Database } from '../../src/data/schema.js'
import { createUndoStateMachine, applyUndoInTransaction, UndoError, UndoAdapterConflict, type UndoTransactionPort } from '../../src/undo/state-machine.js'
import type { Backend } from '../../src/data/repositories.js'

const defaultOwner = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222'
const stamp = '2026-01-01 00:00:00.000000', clock = () => '2026-01-02T00:00:00Z'
export async function contract(db: Kysely<Database>, backend: Backend, owner = defaultOwner, port?: UndoTransactionPort) {
  const key = backend === 'sqlite' ? owner.replaceAll('-', '') : owner
  const node = { id: 1, user_id: key, kind: 'note', title: '新', content_md: '', content_plain: '', color: null, ref_type: null, ref_id: null, ref_snapshot: null, origin: 'user', indexed_at: null, indexed_hash: null, version: 1, captured_at: stamp, created_at: stamp, updated_at: stamp, deleted_at: null }
  await db.insertInto('mind_nodes').values(node).execute()
  const snapshot = { kind: 'note', title: '新', content_md: '', content_plain: '', color: null, captured_at: stamp, deleted_at: null }
  const insert = async (id: string, resource = 'mind', extra: Record<string, unknown> = {}) => db.insertInto('undo_operations').values({ id, user_id: key, undo_context_id: 'ctx', group_id: id, resource, action: 'create', target_refs: '[1]', before_state: '{}', after_state: JSON.stringify({ items: { 'note:1': snapshot } }), base_versions: '{}', artifact_refs: '{}', actor_type: 'web', status: 'active', created_at: stamp, undone_at: null, expires_at: null, failure_code: null, ...extra }).execute()
  const events: Record<string, unknown>[] = []
  const api = createUndoStateMachine(port ?? { backend, read: work => work(db), transaction: work => db.transaction().execute(work) }, async (_owner, event) => { events.push(event) }, clock)
  await insert('mind')
  await insert('calendar', 'calendar', { created_at: '2026-01-01 01:00:00.000000' })
  await insert('prototype', 'toString')
  await assert.rejects(api.apply(owner, 'ctx', 'prototype', 'undo'), (e: unknown) => e instanceof UndoError && e.code === 'undo.unsupported')
  assert.equal((await api.preview(owner, 'ctx')).undo?.operation_id, 'calendar')
  await assert.rejects(api.apply(owner, 'ctx', 'calendar', 'undo'), (e: unknown) => e instanceof UndoError && e.code === 'undo.unsupported')
  await assert.rejects(api.apply(other, 'ctx', 'mind', 'undo'), (e: unknown) => e instanceof UndoError && e.statusCode === 404)
  await assert.rejects(api.apply(owner, 'other', 'mind', 'undo'), (e: unknown) => e instanceof UndoError && e.statusCode === 404)
  assert.equal((await api.apply(owner, 'ctx', 'mind', 'undo')).idempotent, false)
  if (backend === 'postgres') {
    const row = await db.selectFrom('undo_operations').select('undone_at').where('id', '=', 'mind').executeTakeFirstOrThrow()
    const dbNow = (await sql<{ now: string }>`SELECT CURRENT_TIMESTAMP AS now`.execute(db)).rows[0]!.now
    assert.ok(Math.abs(new Date(row.undone_at!).getTime() - new Date(dbNow).getTime()) < 15_000)
    assert.ok(Math.abs(new Date(row.undone_at!).getTime() - new Date(clock()).getTime()) > 86_400_000)
  }
  assert.equal((await api.apply(owner, 'ctx', 'mind', 'undo')).idempotent, true)
  assert.equal(events.length, 1)
  assert.ok((await db.selectFrom('mind_nodes').selectAll().where('id', '=', 1).executeTakeFirstOrThrow()).deleted_at)
  await api.apply(owner, 'ctx', 'mind', 'redo')
  assert.equal(events.length, 2)
  assert.equal((await db.selectFrom('mind_nodes').selectAll().where('id', '=', 1).executeTakeFirstOrThrow()).deleted_at, null)
  if (backend === 'postgres') {
    const results = await Promise.all([api.apply(owner, 'ctx', 'mind', 'undo'), api.apply(owner, 'ctx', 'mind', 'undo')])
    assert.deepEqual(results.map(result => result.idempotent).sort(), [false, true])
    assert.equal(events.length, 3)
    await api.apply(owner, 'ctx', 'mind', 'redo')
  }
  const eventCount = events.length
  await db.updateTable('mind_nodes').set({ title: '外部修改' }).where('id', '=', 1).execute()
  await assert.rejects(api.apply(owner, 'ctx', 'mind', 'undo'), (e: unknown) => e instanceof UndoError && e.code === 'undo.conflict')
  assert.equal((await db.selectFrom('undo_operations').selectAll().where('id', '=', 'mind').executeTakeFirstOrThrow()).status, 'conflicted')
  assert.equal(events.length, eventCount)
  await insert('expired', 'mind', { expires_at: stamp, status: 'undone' })
  await assert.rejects(api.apply(owner, 'ctx', 'expired', 'undo'), (e: unknown) => e instanceof UndoError && e.code === 'undo.expired')
  assert.equal((await db.selectFrom('undo_operations').selectAll().where('id', '=', 'expired').executeTakeFirstOrThrow()).status, 'expired')
  await insert('agent', 'mind', { actor_type: 'agent' })
  await assert.rejects(api.apply(owner, 'ctx', 'agent', 'undo'), (e: unknown) => e instanceof UndoError && e.statusCode === 404)
  await insert('calendar-conflict', 'calendar')
  await insert('calendar-success', 'calendar')
  const phases: string[] = [], adapterEvents: Record<string, unknown>[] = []
  const custom = createUndoStateMachine(port ?? { backend, read: work => work(db), transaction: work => db.transaction().execute(work) }, async (_owner, event) => { adapterEvents.push(event) }, clock, {
    calendar: { async apply({ tx, row }) {
      phases.push('apply')
      await tx.updateTable('mind_nodes').set({ title: '适配器写入' }).where('id', '=', 1).execute()
      if (row.id === 'calendar-conflict') throw new UndoAdapterConflict('undo.conflict', '测试冲突')
      return { versions: { 'event:1': 2 }, events: [{ resource: 'calendar' }] }
    } },
  })
  const hooks = {
    async validateClaim() { phases.push('validate') },
    async prepare() { phases.push('prepare') },
    async rollbackExternal() { phases.push('compensate') },
    beforeCommit() { phases.push('beforeCommit') },
    async afterCommit() { phases.push('afterCommit') },
  }
  await assert.rejects(custom.apply(owner, 'ctx', 'calendar-conflict', 'undo', hooks), (e: unknown) => e instanceof UndoError && e.code === 'undo.conflict')
  assert.deepEqual(phases, ['validate', 'prepare', 'apply', 'compensate', 'afterCommit'])
  assert.equal((await db.selectFrom('mind_nodes').selectAll().where('id', '=', 1).executeTakeFirstOrThrow()).title, '外部修改')
  assert.equal((await db.selectFrom('undo_operations').selectAll().where('id', '=', 'calendar-conflict').executeTakeFirstOrThrow()).status, 'conflicted')
  assert.equal(adapterEvents.length, 0)
  phases.length = 0
  await custom.apply(owner, 'ctx', 'calendar-success', 'undo', hooks)
  assert.deepEqual(phases, ['validate', 'prepare', 'apply', 'beforeCommit', 'afterCommit'])
  assert.equal((await db.selectFrom('mind_nodes').selectAll().where('id', '=', 1).executeTakeFirstOrThrow()).title, '适配器写入')
  const changed = await db.selectFrom('undo_operations').selectAll().where('id', '=', 'calendar-success').executeTakeFirstOrThrow()
  assert.equal(changed.status, 'undone')
  const changedState = typeof changed.after_state === 'string' ? JSON.parse(changed.after_state) : changed.after_state as any
  assert.deepEqual(changedState.undo_versions, { 'event:1': 2 })
  assert.deepEqual(adapterEvents, [{ resource: 'calendar' }])
  // 模拟 receipt 调用方：状态变化与结果一同提交，读取旧收据不重新执行或发送事件。
  await db.updateTable('mind_nodes').set({ title: '新', version: 1, deleted_at: null }).where('id', '=', 1).execute()
  await insert('receipt-op')
  const transaction = port?.transaction ?? (<T>(work: (tx: Kysely<Database>) => Promise<T>) => db.transaction().execute(work))
  const writeReceipt = async (tx: Kysely<Database>) => {
    const outcome = await applyUndoInTransaction(tx, backend, owner, 'ctx', 'receipt-op', 'undo', { clock })
    await tx.insertInto('core_operation_receipts').values({ owner_id: key, operation_id: 'receipt-test', fingerprint: 'test', method: 'undo.apply', result_json: JSON.stringify(outcome), created_at: stamp }).execute()
    return outcome
  }
  await assert.rejects(transaction(async tx => { await writeReceipt(tx); throw new Error('注入回滚') }), /注入回滚/)
  assert.equal((await db.selectFrom('undo_operations').select('status').where('id', '=', 'receipt-op').executeTakeFirstOrThrow()).status, 'active')
  assert.equal((await db.selectFrom('mind_nodes').select('deleted_at').where('id', '=', 1).executeTakeFirstOrThrow()).deleted_at, null)
  assert.equal(await db.selectFrom('core_operation_receipts').selectAll().where('operation_id', '=', 'receipt-test').executeTakeFirst(), undefined)
  const first = await transaction(writeReceipt)
  assert.equal(first.result?.events.length, 1)
  const receipt = await db.selectFrom('core_operation_receipts').selectAll().where('operation_id', '=', 'receipt-test').executeTakeFirstOrThrow()
  assert.deepEqual(JSON.parse(receipt.result_json), JSON.parse(JSON.stringify(first)))
  assert.equal((await db.selectFrom('undo_operations').select('status').where('id', '=', 'receipt-op').executeTakeFirstOrThrow()).status, 'undone')
  await insert('receipt-conflict')
  const failed = await transaction(async tx => {
    const outcome = await applyUndoInTransaction(tx, backend, owner, 'ctx', 'receipt-conflict', 'undo', { clock })
    await tx.insertInto('core_operation_receipts').values({ owner_id: key, operation_id: 'receipt-conflict', fingerprint: 'test', method: 'undo.apply', result_json: JSON.stringify(outcome), created_at: stamp }).execute()
    return outcome
  })
  assert.equal(failed.error?.code, 'undo.conflict')
  assert.equal((await db.selectFrom('undo_operations').select('status').where('id', '=', 'receipt-conflict').executeTakeFirstOrThrow()).status, 'conflicted')
  assert.equal(JSON.parse((await db.selectFrom('core_operation_receipts').select('result_json').where('operation_id', '=', 'receipt-conflict').executeTakeFirstOrThrow()).result_json).error.code, 'undo.conflict')

}
