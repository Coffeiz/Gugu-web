import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { dataContext } from '../../src/contracts/index.js'
import type { SqlDataRuntime } from '../../src/data/runtime.js'
import { applyUndoInTransaction } from '../../src/undo/state-machine.js'

export async function runtimeOperationContract(runtime: SqlDataRuntime, owner: string) {
  const context = dataContext(owner), db = runtime.db, key = runtime.backend === 'sqlite' ? owner.replaceAll('-', '') : owner
  const stamp = '2026-01-01 00:00:00.000000', token = randomUUID()
  await db.insertInto('mind_nodes').values({ id: 10, user_id: key, kind: 'note', title: '事务', content_md: '', content_plain: '', color: null, ref_type: null, ref_id: null, ref_snapshot: null, origin: 'user', indexed_at: null, indexed_hash: null, version: 1, captured_at: stamp, created_at: stamp, updated_at: stamp, deleted_at: null }).execute()
  const snapshot = { kind: 'note', title: '事务', content_md: '', content_plain: '', color: null, captured_at: stamp, deleted_at: null }
  const add = (id: string) => db.insertInto('undo_operations').values({ id, user_id: key, undo_context_id: 'receipt', group_id: id, resource: 'mind', action: 'create', target_refs: '[10]', before_state: '{}', after_state: JSON.stringify({ items: { 'note:10': snapshot } }), base_versions: '{}', artifact_refs: '{}', actor_type: 'web', status: 'active', created_at: stamp, undone_at: null, expires_at: null, failure_code: null }).execute()
  await add('receipt-atomic')
  const params = { context: 'receipt', undo_id: 'receipt-atomic' }
  let calls = 0, events = 0
  const work = async (tx: Parameters<Parameters<typeof runtime.operationWithTransaction>[4]>[0]) => { calls++; return applyUndoInTransaction(tx, runtime.backend, owner, 'receipt', 'receipt-atomic', 'undo') }
  const first = await runtime.operationWithTransaction(context, token, 'undo.apply', params, work)
  if (!first.replayed) events += first.result.result?.events.length ?? 0
  assert.equal(first.replayed, false)
  assert.equal(first.result.result?.events.length, 1)
  const replay = await runtime.operationWithTransaction(context, token, 'undo.apply', params, work)
  if (!replay.replayed) events += replay.result.result?.events.length ?? 0
  assert.equal(replay.replayed, true)
  assert.equal(calls, 1)
  assert.equal(events, 1)
  assert.deepEqual(replay.result, first.result)
  assert.deepEqual(await runtime.receipt(context, token), { method: 'undo.apply', result: first.result })
  await assert.rejects(runtime.operationWithTransaction(context, token, 'undo.apply', { ...params, context: 'other' }, work), (error: any) => error.code === 'conflict')
  const legacy = randomUUID()
  assert.deepEqual(await runtime.operation(context, legacy, 'legacy', {}, async () => ({ value: 1 })), { value: 1 })
  assert.deepEqual(await runtime.receipt(context, legacy), { method: 'legacy', result: { value: 1 } })
  await add('receipt-conflict-runtime')
  const conflictToken = randomUUID()
  const conflict = await runtime.operationWithTransaction(context, conflictToken, 'undo.apply', { id: 'receipt-conflict-runtime' }, tx => applyUndoInTransaction(tx, runtime.backend, owner, 'receipt', 'receipt-conflict-runtime', 'undo'))
  assert.equal(conflict.result.error?.code, 'undo.conflict')
  assert.equal((await db.selectFrom('undo_operations').select('status').where('id', '=', 'receipt-conflict-runtime').executeTakeFirstOrThrow()).status, 'conflicted')
  assert.equal((await runtime.receipt(context, conflictToken))?.method, 'undo.apply')
  const rollbackToken = randomUUID()
  await assert.rejects(runtime.operationWithTransaction(context, rollbackToken, 'undo.test', {}, async tx => {
    await tx.updateTable('mind_nodes').set({ title: '不提交' }).where('id', '=', 10).execute()
    throw new Error('注入失败')
  }), /注入失败/)
  assert.equal((await db.selectFrom('mind_nodes').select('title').where('id', '=', 10).executeTakeFirstOrThrow()).title, '事务')
  assert.equal(await runtime.receipt(context, rollbackToken), null)
  const cancelled = { aborted: false }, cancelledToken = randomUUID()
  await assert.rejects(runtime.operationWithTransaction(context, cancelledToken, 'undo.test', {}, async tx => {
    await tx.updateTable('mind_nodes').set({ title: '取消' }).where('id', '=', 10).execute()
    cancelled.aborted = true
    return { saved: true }
  }, { signal: cancelled }), (error: any) => error.code === 'cancelled')
  assert.equal((await db.selectFrom('mind_nodes').select('title').where('id', '=', 10).executeTakeFirstOrThrow()).title, '事务')
  assert.equal(await runtime.receipt(context, cancelledToken), null)
  // 提交已完成而响应丢失时，使用同一标识查询并重放，不再执行 work。
  const unknownToken = randomUUID()
  await assert.rejects((async () => { await runtime.operationWithTransaction(context, unknownToken, 'undo.test', { id: 10 }, async () => ({ saved: true })); throw new Error('响应丢失') })(), /响应丢失/)
  assert.deepEqual(await runtime.receipt(context, unknownToken), { method: 'undo.test', result: { saved: true } })
  const recovered = await runtime.operationWithTransaction(context, unknownToken, 'undo.test', { id: 10 }, async () => { throw new Error('不得重放') })
  assert.deepEqual(recovered, { result: { saved: true }, replayed: true })
}
