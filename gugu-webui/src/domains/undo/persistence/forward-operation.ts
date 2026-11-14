import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'

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

function undoId(prefix: 'op' | 'group'): string {
  return `${prefix}-${randomUUID().replaceAll('-', '')}`
}

function serialize(value: unknown): string {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('Undo 状态无法序列化')
  return encoded
}

/** 清理同一 web Undo context 的 redo 分支，并在当前业务事务中插入操作记录。 */
export async function recordForwardUndoOperation(
  client: PoolClient,
  record: ForwardUndoOperation,
): Promise<void> {
  await client.query(
    `UPDATE undo_operations
     SET status = 'expired', failure_code = 'redo_cleared_by_new_operation'
     WHERE user_id = $1 AND undo_context_id = $2 AND actor_type = 'web' AND status = 'undone'`,
    [record.userId, record.contextId],
  )
  await client.query(
    `INSERT INTO undo_operations (
       id, user_id, undo_context_id, group_id, resource, action, target_refs,
       before_state, after_state, base_versions, artifact_refs, actor_type,
       status, created_at, expires_at, undone_at, failure_code
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7::json, $8::json, $9::json, $10::json,
       '{}'::json, 'web', 'active', CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP + INTERVAL '30 days', NULL, NULL
     )`,
    [
      undoId('op'), record.userId, record.contextId, undoId('group'), record.resource, record.action,
      serialize(record.targetRefs), serialize(record.beforeState), serialize(record.afterState),
      serialize(record.baseVersions),
    ],
  )
}
