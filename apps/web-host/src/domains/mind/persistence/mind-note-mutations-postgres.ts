import type { Pool, PoolClient } from 'pg'
import { withPostgresTransaction } from '../../../adapters/postgres-transaction.js'
import { MindNoteMutationError, type MindNoteUpdateInput } from '../application/mind-note-mutations.js'
import { toMindNoteReadResponse, type MindNoteReadResponse } from '../mind-notes-read.js'
import { mindNoteUndoSnapshot, type MindNotePersistenceRow } from './mind-note-snapshot.js'
import { recordMindNoteUndo } from './mind-note-undo.js'

const noteColumns = `id, kind, title, content_md, content_plain, color, captured_at,
  version, created_at, updated_at, deleted_at, ref_type, ref_id, ref_snapshot, origin`

async function findLiveNote(
  client: PoolClient,
  ownerId: string,
  noteId: number,
): Promise<MindNotePersistenceRow> {
  const result = await client.query<MindNotePersistenceRow>(
    `SELECT ${noteColumns} FROM mind_nodes
     WHERE id = $1 AND user_id = $2 AND kind = 'note' AND deleted_at IS NULL
     FOR UPDATE`,
    [noteId, ownerId],
  )
  const row = result.rows[0]
  if (!row) throw new MindNoteMutationError('便签不存在', 404)
  return row
}

/** 更新与 Undo 同事务；owner、kind、活动态和版本均约束在持锁后的写入中。 */
export function createPostgresMindNoteMutator(pool: Pick<Pool, 'connect'>) {
  return {
    async update(
      ownerId: string,
      noteId: number,
      input: MindNoteUpdateInput,
      undoContextId: string | null,
    ): Promise<{ note: MindNoteReadResponse; changed: boolean }> {
      return withPostgresTransaction(pool, async (client) => {
        const before = await findLiveNote(client, ownerId, noteId)
        const beforeVersion = Number(before.version)
        const fields: Array<[string, unknown]> = []
        if (input.contentMd !== undefined) {
          fields.push(['content_md', input.contentMd], ['content_plain', input.contentPlain],
            ['indexed_hash', input.indexedHash])
        }
        if (input.title !== undefined) fields.push(['title', input.title])
        if (input.color !== undefined) fields.push(['color', input.color])
        if (input.capturedAt !== undefined) fields.push(['captured_at', input.capturedAt])
        if (fields.length === 0) return { note: toMindNoteReadResponse(before), changed: false }
        if (input.version !== beforeVersion)
          throw new MindNoteMutationError('便签已被其他端修改，请刷新后重试', 409)

        const values: unknown[] = [noteId, ownerId, input.version]
        const assignments = fields.map(([column, value]) => {
          values.push(value)
          return `${column} = $${values.length}`
        })
        if (input.contentMd !== undefined) assignments.push('indexed_at = NULL')
        assignments.push('version = version + 1', 'updated_at = CURRENT_TIMESTAMP')

        const updated = await client.query<MindNotePersistenceRow>(
          `UPDATE mind_nodes SET ${assignments.join(', ')}
           WHERE id = $1 AND user_id = $2 AND kind = 'note'
             AND version = $3 AND deleted_at IS NULL
           RETURNING ${noteColumns}`,
          values,
        )
        const after = updated.rows[0]
        if (!after) throw new MindNoteMutationError('便签已被其他端修改，请刷新后重试', 409)

        await recordMindNoteUndo(client, {
          ownerId,
          contextId: undoContextId,
          action: 'update',
          noteId,
          beforeSnapshot: mindNoteUndoSnapshot(before),
          afterSnapshot: mindNoteUndoSnapshot(after),
          baseVersion: beforeVersion,
        })
        return { note: toMindNoteReadResponse(after), changed: true }
      })
    },

    async delete(ownerId: string, noteId: number, undoContextId: string | null): Promise<void> {
      await withPostgresTransaction(pool, async (client) => {
        const before = await findLiveNote(client, ownerId, noteId)
        const beforeVersion = Number(before.version)
        const deleted = await client.query<MindNotePersistenceRow>(
          `UPDATE mind_nodes
           SET deleted_at = CURRENT_TIMESTAMP, version = version + 1, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND user_id = $2 AND kind = 'note'
             AND version = $3 AND deleted_at IS NULL
           RETURNING ${noteColumns}`,
          [noteId, ownerId, beforeVersion],
        )
        const after = deleted.rows[0]
        if (!after) throw new MindNoteMutationError('便签已被其他端修改，请刷新后重试', 409)

        await recordMindNoteUndo(client, {
          ownerId,
          contextId: undoContextId,
          action: 'delete',
          noteId,
          beforeSnapshot: mindNoteUndoSnapshot(before),
          afterSnapshot: mindNoteUndoSnapshot(after),
          baseVersion: beforeVersion,
        })
      })
    },
  }
}
