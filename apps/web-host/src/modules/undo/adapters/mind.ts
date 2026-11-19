import type { PoolClient } from 'pg'
import { applyMindUndoWithPostgresClient, MindUndoConflict as CoreMindUndoConflict, MindUndoUnsupported as CoreMindUndoUnsupported } from '@gugu/core/mind'
import { MindUndoConflict, MindUndoUnsupported } from '../errors.js'

/** 使用外层已认领事务，保留现有跨资源错误类型。 */
export async function applyMindUndoCore(client: PoolClient, ownerId: string, operation: Parameters<typeof applyMindUndoWithPostgresClient>[2], mode: 'undo' | 'redo') {
  try { return await applyMindUndoWithPostgresClient(client, ownerId, operation, mode) }
  catch (error) {
    if (error instanceof CoreMindUndoConflict) throw new MindUndoConflict(error.message)
    if (error instanceof CoreMindUndoUnsupported) throw new MindUndoUnsupported()
    throw error
  }
}
