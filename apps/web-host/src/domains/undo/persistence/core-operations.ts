import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { createUndoStateMachine, UndoAdapterConflict, UndoAdapterUnsupported, UndoError as CoreUndoError, type UndoAdapterContext, type UndoTransactionPort } from '@gugu/core/undo'
import { createFileUndoAdapter } from '@gugu/core/undo/file-adapter'
import { UndoError } from '../undo.js'
import { applyCalendarUndo } from './calendar.js'
import { MindUndoConflict, MindUndoUnsupported } from './mind.js'
import { applyProjectUndo, type ProjectUndoStorage } from './projects.js'
import { appendProjectUndoMove, saveProjectUndoJournal } from './project-journal.js'
import { readFileUndoArtifact } from './files.js'

export interface FileUndoStorage {
  read(key: string): Promise<Uint8Array | null>
  replace(key: string, bytes: Uint8Array): Promise<{ rollback(): Promise<void>; finalize(): Promise<void> }>
}

/** 查询只覆盖两个旧资源适配器的参数化语句，生命周期不得越过当前调用。 */
export async function withUndoTransactionClient<T>(tx: UndoAdapterContext['tx'], work: (client: PoolClient) => Promise<T>): Promise<T> {
  let active = true, pending: Promise<unknown> | null = null
  const client = {
    async query(text: string, parameters: unknown[] = []) {
      if (!active || pending) throw new Error('撤销事务查询已结束或正在执行')
      const select = /^SELECT \* FROM (?:calendar_events|scheduled_tasks|projects|files|folders) WHERE id=\$1 AND user_id=\$2 FOR UPDATE$/
      const column = '(?:title|date|time|end_time|type|contact_name|project_id|description|deleted_at|enabled|name|payload|cron|schedule_kind|start_at|reminder_lead_minutes|channels|delivery_targets|summary|status|start_date|deadline|color|progress|current_stage|priority|archived|done_at|stages_json|storage_key|display_name)'
      const assignment = `(?:${column}=\\$[1-9][0-9]*|version=COALESCE\\(version,1\\)\\+1|storage_key=\\$3 \\|\\| substring\\(storage_key from char_length\\(\\$4\\)\\+1\\))`
      const update = new RegExp(`^UPDATE (?:calendar_events|scheduled_tasks|projects|files|folders) SET ${assignment}(?:, ?${assignment})* WHERE (?:id=\\$1 AND user_id=\\$2|user_id=\\$1 AND project_id=\\$2 AND left\\(storage_key,char_length\\(\\$4\\)\\)=\\$4)(?: RETURNING (?:version|\\*))?$`)
      if (typeof text !== 'string' || /;|--|\/\*|\*\//.test(text) || !(select.test(text) || update.test(text)) || !Array.isArray(parameters) || parameters.length < 2) throw new Error('撤销事务查询不允许该语句')
      const query = { sql: text, parameters, query: { kind: 'RawNode', sqlFragments: [text], parameters: [] } }
      const current = tx.executeQuery(query as unknown as Parameters<typeof tx.executeQuery>[0])
      pending = current
      try {
        const result = await current
        return { rows: result.rows, rowCount: result.numAffectedRows === undefined ? result.rows.length : Number(result.numAffectedRows) }
      } finally { pending = null }
    },
  } as unknown as PoolClient
  try {
    const result = await work(client)
    if (pending) { await (pending as Promise<unknown>).catch(() => undefined); throw new Error('撤销事务查询未等待') }
    return result
  } finally {
    active = false
    if (pending) await (pending as Promise<unknown>).catch(() => undefined)
  }
}
function operation(row: UndoAdapterContext['row']) {
  const decode = (value: unknown) => typeof value === 'string' ? JSON.parse(value) : value
  return { id: row.id, action: row.action, before_state: decode(row.before_state), after_state: decode(row.after_state) }
}
async function mapped<T>(work: () => Promise<T>): Promise<T> {
  try { return await work() }
  catch (error) {
    if (error instanceof MindUndoConflict) throw new UndoAdapterConflict(error.code, error.message)
    if (error instanceof MindUndoUnsupported) throw new UndoAdapterUnsupported(error.code, error.message)
    throw error
  }
}
/** 仅用于隔离验收；调用方须提供正式 PostgreSQL 事务端口和项目存储。 */
export function createHostCoreUndoOperations(pool: Pick<Pool, 'query' | 'connect'>, port: UndoTransactionPort, publish: (owner: string, event: Record<string, unknown>) => Promise<void>, storage?: ProjectUndoStorage, fileStorage?: FileUndoStorage) {
  if (port.backend !== 'postgres' && storage) throw new Error('项目 Undo Host 适配器需要 PostgreSQL 事务')
  const previewEngine = createUndoStateMachine(port, publish)
  return {
    preview: previewEngine.preview,
    async apply(owner: string, contextId: string, operationId: string, mode: 'undo' | 'redo') {
      const rollbacks: Array<() => Promise<void>> = []
      const finalizers: Array<() => Promise<void>> = []
      let readyToCommit = false, journalId: string | null = null, locked = false, released = false
      const resource = storage ? await pool.query<{ resource: string }>('SELECT resource FROM undo_operations WHERE id=$1 AND user_id=$2 AND undo_context_id=$3 AND actor_type=\'web\'', [operationId, owner, contextId.trim().slice(0, 128) || null]) : null
      const lockClient = resource?.rows[0]?.resource === 'projects' ? await pool.connect() : null
      async function releaseLock() {
        if (!lockClient || released) return
        let discard = false
        if (locked) try { await lockClient.query("SELECT pg_advisory_unlock(hashtext('gugu-project-undo-journal'))") } catch { discard = true }
        released = true
        locked = false
        lockClient.release(discard)
      }
      try {
        if (lockClient) {
          await lockClient.query("SELECT pg_advisory_lock(hashtext('gugu-project-undo-journal'))")
          locked = true
          if ((await lockClient.query('SELECT id FROM project_undo_journals LIMIT 1')).rowCount) throw new UndoError('undo.recovery_required', '项目撤销文件恢复尚未完成，请稍后重试', 503)
        }
        const adapters = {
          ...(port.backend === 'postgres' ? {
            calendar: { apply: ({ tx, owner, row, mode }: UndoAdapterContext) => mapped(() => withUndoTransactionClient(tx, client => applyCalendarUndo(client, owner, operation(row), mode))) },
            ...(storage ? { projects: { apply: ({ tx, owner, row, mode }: UndoAdapterContext) => mapped(() => withUndoTransactionClient(tx, client => applyProjectUndo(client, owner, operation(row), mode, storage, rollbacks, (from, to) => appendProjectUndoMove(lockClient!, journalId!, { from, to })))) } } : {}),
          } : {}),
          files: createFileUndoAdapter(port.backend, {
            async restore(input) {
              if (!fileStorage) throw new UndoAdapterUnsupported('undo.unsupported', '文件正文撤销存储尚未接入')
              const bytes = await readFileUndoArtifact(input.ownerId, input.ref, input.artifactRefs, input.mode, fileStorage.read)
              return bytes === null ? null : fileStorage.replace(input.storageKey, bytes)
            },
          }, rollbacks, finalizers),
        }
        const engine = createUndoStateMachine(port, publish, undefined, adapters)
        return await engine.apply(owner, contextId, operationId, mode, {
          async validateClaim({ row }) {
            if (row.resource === 'projects' && storage && !locked) throw new UndoError('undo.recovery_required', '项目撤销状态已变化，请重试', 409)
          },
          async prepare({ row }) {
            if (row.resource !== 'projects') return
            journalId = randomUUID()
            await saveProjectUndoJournal(lockClient!, { id: journalId, ownerId: owner, operationId, beforeStatus: mode === 'undo' ? 'active' : 'undone', afterStatus: mode === 'undo' ? 'undone' : 'active', moves: [] })
          },
          async rollbackExternal() { for (const undo of rollbacks.reverse()) await undo(); rollbacks.length = 0 },
          beforeCommit() { readyToCommit = true },
          async afterCommit() {
            for (const finalize of finalizers) await finalize().catch(() => console.error('文件撤销备份清理失败'))
            if (journalId) await lockClient!.query('DELETE FROM project_undo_journals WHERE id=$1', [journalId])
            await releaseLock()
          },
        })
      } catch (error) {
        if (!readyToCommit) for (const undo of rollbacks.reverse()) await undo()
        if (error instanceof CoreUndoError) throw new UndoError(error.code, error.message, error.statusCode)
        throw error
      } finally {
        await releaseLock()
      }
    },
  }
}
