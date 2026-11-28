import { sql, type Kysely, type Selectable } from 'kysely'
import { dataContext } from '../contracts/index.js'
import { databaseTime, nowUtc, type Clock } from '../data/codec.js'
import type { Backend } from '../data/repositories.js'
import type { SqlDataRuntime } from '../data/runtime.js'
import type { Database, UndoTable } from '../data/schema.js'
import { applyMindUndoInTransaction, MindUndoConflict, MindUndoUnsupported } from '../mind/undo-adapter.js'

export type UndoRow = Selectable<UndoTable>
type Row = UndoRow
export type UndoMode = 'undo' | 'redo'
type Mode = UndoMode
export type UndoEvent = Record<string, unknown>
type Event = UndoEvent
export class UndoError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 409) { super(message); this.name = 'UndoError' }
}
export class UndoAdapterConflict extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'UndoAdapterConflict' }
}
export class UndoAdapterUnsupported extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'UndoAdapterUnsupported' }
}
export interface UndoAdapterContext {
  tx: Kysely<Database>
  owner: string
  row: UndoRow
  mode: UndoMode
}
export interface UndoResourceAdapter {
  apply(context: UndoAdapterContext): Promise<{ versions: Record<string, unknown>; events: UndoEvent[] }>
}
/** 回调只在同一认领事务中调用；外层负责项目锁、journal 和未知提交恢复。 */
export interface UndoApplyHooks {
  validateClaim?(context: UndoAdapterContext): Promise<void>
  prepare?(context: UndoAdapterContext): Promise<void>
  rollbackExternal?(context: UndoAdapterContext): Promise<void>
  beforeCommit?(context: UndoAdapterContext): void
  afterCommit?(): Promise<void>
}
export type UndoAdapterRegistry = Readonly<Record<string, UndoResourceAdapter | undefined>>
/** SQLite 事务必须在读取前取得写锁（BEGIN IMMEDIATE）；PG 使用行锁。回调结束后必须提交或抛出。 */
export interface UndoTransactionPort {
  readonly backend: Backend
  read<T>(work: (db: Kysely<Database>) => Promise<T>): Promise<T>
  transaction<T>(work: (tx: Kysely<Database>) => Promise<T>): Promise<T>
}
/** 直接使用正式 runtime 的事务；SQLite runtime 的驱动以 BEGIN IMMEDIATE 开始事务。 */
export function createRuntimeUndoTransactionPort(runtime: SqlDataRuntime): UndoTransactionPort {
  return {
    backend: runtime.backend,
    read: work => work(runtime.db),
    transaction: work => runtime.db.transaction().execute(work),
  }
}
const context = (value: string) => value.trim().slice(0, 128) || null
const json = (value: unknown): any => typeof value === 'string' ? JSON.parse(value) : value
const date = (value: unknown) => new Date(value as string | Date).getTime()
function shape(row: Row) {
  const refs = json(row.target_refs), count = Array.isArray(refs) ? refs.length : 0
  return { operation_id: row.id, group_id: row.group_id, resource: row.resource, action: row.action,
    target_count: count, summary: `${row.action} ${count} 个对象`, created_at: new Date(row.created_at).toISOString(),
    status: row.status, can_undo: row.status === 'active', can_redo: row.status === 'undone' }
}
/** 保留期清理成功后写入的终态，避免 redo 分支清理任务被重复扫描。 */
export function undoRetentionCompletion(failureCode: string | null): { status: 'expired'; failureCode: string } {
  return {
    status: 'expired',
    failureCode: failureCode === 'redo_cleared_by_new_operation' ? 'redo_artifacts_cleaned' : failureCode ?? 'retention_expired',
  }
}
/** 调用方持有事务；返回的错误须在提交后转成异常，不能在此处发布事件。 */
export async function applyUndoInTransaction(
  tx: Kysely<Database>, backend: Backend, owner: string, rawContext: string,
  operationId: string, mode: UndoMode, options: { clock?: Clock; adapters?: UndoAdapterRegistry; hooks?: UndoApplyHooks } = {},
) {
  const clock = options.clock ?? nowUtc, adapters = options.adapters ?? {}, hooks = options.hooks ?? {}
  const canonical = dataContext(owner).ownerId, key = backend === 'sqlite' ? canonical.replaceAll('-', '') : canonical
  const ctx = context(rawContext)
  let query = tx.selectFrom('undo_operations').selectAll().where('id', '=', operationId).where('user_id', '=', key).where('undo_context_id', '=', ctx ?? '').where('actor_type', '=', 'web')
  if (backend === 'postgres') query = query.forUpdate()
  const row = await query.executeTakeFirst()
  if (!row) throw new UndoError('undo.not_found', '撤销操作不存在或不属于当前用户', 404)
  const adapterContext = { tx, owner, row, mode }
  await hooks.validateClaim?.(adapterContext)
  if (row.expires_at && date(row.expires_at) <= date(clock())) {
    await tx.updateTable('undo_operations').set({ status: 'expired', failure_code: 'retention_expired' }).where('id', '=', row.id).execute()
    return { error: { code: 'undo.expired', message: '撤销操作已超过保留期限', statusCode: 409 } }
  }
  const expected = mode === 'undo' ? 'active' : 'undone'
  if (row.status !== expected) {
    if ((mode === 'undo' && row.status === 'undone') || (mode === 'redo' && row.status === 'active')) return { result: { operation: shape(row), idempotent: true, events: [] as Event[] } }
    throw new UndoError('undo.already_processed', '撤销操作已经处理、冲突或过期')
  }
  const adapter = (Object.hasOwn(adapters, row.resource) ? adapters[row.resource] : undefined) ?? (row.resource === 'mind' ? { apply: ({ tx, owner, row, mode }: UndoAdapterContext) => applyMindUndoInTransaction(tx, backend, owner, { id: row.id, action: row.action, before_state: json(row.before_state), after_state: json(row.after_state) }, mode, clock) } : undefined)
  if (!adapter) throw new UndoError('undo.unsupported', '该资源尚未接入统一撤销适配器')
  await hooks.prepare?.(adapterContext)
  await sql`SAVEPOINT undo_apply`.execute(tx)
  let applied
  try {
    applied = await adapter.apply(adapterContext)
    await sql`RELEASE SAVEPOINT undo_apply`.execute(tx)
  } catch (error) {
    if (!(error instanceof MindUndoConflict || error instanceof MindUndoUnsupported || error instanceof UndoAdapterConflict || error instanceof UndoAdapterUnsupported)) throw error
    await sql`ROLLBACK TO SAVEPOINT undo_apply`.execute(tx)
    await sql`RELEASE SAVEPOINT undo_apply`.execute(tx)
    await hooks.rollbackExternal?.(adapterContext)
    await tx.updateTable('undo_operations').set({ status: error instanceof MindUndoConflict || error instanceof UndoAdapterConflict ? 'conflicted' : 'failed', failure_code: error.code }).where('id', '=', row.id).execute()
    return { error: { code: error.code, message: error.message, statusCode: 409 } }
  }
  const state = json(row.after_state)
  const changed = await tx.updateTable('undo_operations').set({ status: mode === 'undo' ? 'undone' : 'active', undone_at: mode === 'undo' ? (backend === 'postgres' ? sql<string>`CURRENT_TIMESTAMP` : databaseTime(clock(), backend)) : null, failure_code: null,
    after_state: JSON.stringify(mode === 'undo' ? { ...state, undo_versions: applied.versions } : state) }).where('id', '=', row.id).returningAll().executeTakeFirstOrThrow()
  hooks.beforeCommit?.(adapterContext)
  return { result: { operation: shape(changed), idempotent: false, events: applied.events } }
}
export function createUndoStateMachine(port: UndoTransactionPort, publish: (owner: string, event: Event) => Promise<void>, clock: Clock = nowUtc, adapters: UndoAdapterRegistry = {}) {
  const ownerKey = (owner: string) => { const id = dataContext(owner).ownerId; return port.backend === 'sqlite' ? id.replaceAll('-', '') : id }
  return {
    async preview(owner: string, rawContext: string) {
      const ctx = context(rawContext)
      if (!ctx) return { available: false, redo_available: false, undo: null, redo: null }
      return port.read(async db => {
        const rows = await db.selectFrom('undo_operations').selectAll().where('user_id', '=', ownerKey(owner)).where('undo_context_id', '=', ctx)
          .where('actor_type', '=', 'web').where('status', 'in', ['active', 'undone']).orderBy('created_at', 'desc').execute()
        const active = rows.find(row => row.status === 'active')
        const undone = rows.filter(row => row.status === 'undone').sort((a, b) => date(b.undone_at) - date(a.undone_at) || date(b.created_at) - date(a.created_at))[0]
        return { available: !!active, redo_available: !!undone, undo: active ? shape(active) : null, redo: undone ? shape(undone) : null }
      })
    },
    async apply(owner: string, rawContext: string, operationId: string, mode: Mode, hooks: UndoApplyHooks = {}) {
      const outcome = await port.transaction(tx => applyUndoInTransaction(tx, port.backend, owner, rawContext, operationId, mode, { clock, adapters, hooks }))
      await hooks.afterCommit?.()
      if (outcome.error) throw new UndoError(outcome.error.code, outcome.error.message, outcome.error.statusCode)
      for (const event of outcome.result!.events) await publish(owner, event)
      return outcome.result!
    },
  }
}
