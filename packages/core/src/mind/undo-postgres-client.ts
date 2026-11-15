import type { PoolClient } from 'pg'
import { withBorrowedMindPostgres } from '../data/borrowed-postgres.js'
import { applyMindUndoInTransaction } from './undo-adapter.js'

/** 借用已开启事务、已认领 Undo 行的 pg client；连接与事务始终由调用方持有。 */
export async function applyMindUndoWithPostgresClient(client: PoolClient, ownerId: string, operation: Parameters<typeof applyMindUndoInTransaction>[3], mode: 'undo' | 'redo') {
  return withBorrowedMindPostgres(client, db => applyMindUndoInTransaction(db, 'postgres', ownerId, operation, mode))
}
