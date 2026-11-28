import { randomUUID } from 'node:crypto'
import type { Transaction } from 'kysely'
import { dataContext } from '../contracts/index.js'
import { databaseTime, nowUtc, utc, type Clock } from './codec.js'
import type { Backend } from './repositories.js'
import type { Database } from './schema.js'

export interface ForwardUndoOperation {
  userId: string
  contextId: string
  resource: string
  action: string
  targetRefs: unknown
  beforeState: unknown
  afterState: unknown
  baseVersions: unknown
}

/** 与业务写入共用事务，清除同一上下文的 redo 分支并写入撤销快照。 */
export async function recordForwardUndoOperation(
  tx: Transaction<Database>, backend: Backend, record: ForwardUndoOperation, clock: Clock = nowUtc,
): Promise<void> {
  const owner = dataContext(record.userId).ownerId
  const userId = backend === 'sqlite' ? owner.replaceAll('-', '') : owner
  const contextId = record.contextId.trim().slice(0, 128)
  if (!contextId) throw new Error('撤销上下文不能为空')
  const encode = (value: unknown): string => {
    const json = JSON.stringify(value)
    if (json === undefined) throw new Error('撤销状态无法序列化')
    return json
  }
  const now = utc(clock())
  const fraction = /\.(\d{6})\+00:00$/.exec(now)?.[1]
  const expiryDate = new Date(new Date(now.replace(' ', 'T')).getTime() + 30 * 86_400_000)
  const expiry = `${expiryDate.toISOString().slice(0, 19)}${fraction ? `.${fraction}` : ''}Z`
  await tx.updateTable('undo_operations').set({ status: 'expired', failure_code: 'redo_cleared_by_new_operation' })
    .where('user_id', '=', userId).where('undo_context_id', '=', contextId)
    .where('actor_type', '=', 'web').where('status', '=', 'undone').execute()
  await tx.insertInto('undo_operations').values({
    id: `op-${randomUUID().replaceAll('-', '')}`, user_id: userId, undo_context_id: contextId,
    group_id: `group-${randomUUID().replaceAll('-', '')}`, resource: record.resource, action: record.action,
    target_refs: encode(record.targetRefs), before_state: encode(record.beforeState), after_state: encode(record.afterState),
    base_versions: encode(record.baseVersions), artifact_refs: '{}', actor_type: 'web', status: 'active',
    created_at: databaseTime(now, backend), expires_at: databaseTime(expiry, backend), undone_at: null, failure_code: null,
  }).execute()
}
