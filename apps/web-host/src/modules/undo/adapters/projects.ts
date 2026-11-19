import type { PoolClient } from 'pg'
import { applyProjectUndo as applyCoreProjectUndo, type ProjectUndoStorage, type ProjectUndoKind } from '@gugu/core/projects/undo'
import { UndoAdapterConflict, UndoAdapterUnsupported } from '@gugu/core/undo'
import { MindUndoConflict, MindUndoUnsupported } from '../errors.js'
export type { ProjectUndoStorage } from '@gugu/core/projects/undo'

type Operation = Parameters<typeof applyCoreProjectUndo>[2]
type Snapshot = Record<string, unknown>
const tables: Record<ProjectUndoKind, string> = { project: 'projects', event: 'calendar_events', file: 'files', folder: 'folders', task: 'scheduled_tasks' }

/** Host 只桥接已有 PG 事务；权限、版本、顺序、快照与文件补偿调度由 Core 决定。 */
export async function applyProjectUndo(client: PoolClient, owner: string, operation: Operation, mode: 'undo' | 'redo', storage: ProjectUndoStorage, rollback: Array<() => Promise<void>>, beforeMove?: (from: string, to: string) => Promise<void>) {
  try {
    return await applyCoreProjectUndo({
      async getOwned(kind, id, user) {
        const result = await client.query<Snapshot>(`SELECT * FROM ${tables[kind]} WHERE id=$1 AND user_id=$2 FOR UPDATE`, [id, user])
        return result.rows[0] ?? null
      },
      async update(kind, id, user, updates) {
        const fields = Object.keys(updates)
        const version = kind === 'task' ? '' : ', version=COALESCE(version,1)+1'
        const result = await client.query<Snapshot>(`UPDATE ${tables[kind]} SET ${fields.map((field, i) => `${field}=$${i + 3}`).join(', ')}${version} WHERE id=$1 AND user_id=$2 RETURNING *`, [id, user, ...fields.map(field => updates[field])])
        return result.rows[0] ?? null
      },
      async renameFilePrefixes(user, id, oldKey, newKey) {
        await client.query(`UPDATE files SET storage_key=$3 || substring(storage_key from char_length($4)+1) WHERE user_id=$1 AND project_id=$2 AND left(storage_key,char_length($4))=$4`, [user, id, newKey, oldKey])
      },
    }, owner, operation, mode, storage, rollback, beforeMove)
  } catch (error) {
    if (error instanceof UndoAdapterConflict) throw new MindUndoConflict(error.message)
    if (error instanceof UndoAdapterUnsupported) throw new MindUndoUnsupported()
    throw error
  }
}
