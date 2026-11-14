import type { Pool } from 'pg'
import { withPostgresTransaction } from '../../../adapters/postgres-transaction.js'
import type { MindNoteCreateInput } from '../application/mind-note-create.js'
import { toMindNoteReadResponse, type MindNoteReadResponse } from '../mind-notes-read.js'
import { mindNoteUndoSnapshot, type MindNotePersistenceRow } from './mind-note-snapshot.js'
import { recordMindNoteUndo } from './mind-note-undo.js'

/** 将 note 与 Python 兼容的 Undo 记录写在同一个 PostgreSQL 事务中。 */
export function createPostgresMindNoteInserter(pool: Pick<Pool, 'connect'>) {
  return async function insertMindNote(
    ownerId: string,
    input: MindNoteCreateInput,
    undoContextId: string | null,
  ): Promise<MindNoteReadResponse> {
    return withPostgresTransaction(pool, async (client) => {
      const result = await client.query<MindNotePersistenceRow>(
        `INSERT INTO mind_nodes (
           user_id, kind, title, content_md, content_plain, color, ref_type, ref_id,
           ref_snapshot, origin, indexed_at, indexed_hash, version, captured_at,
           created_at, updated_at, deleted_at
         ) VALUES (
           $1, 'note', $2, $3, $4, $5, NULL, NULL, NULL, 'user', NULL, $6, 1,
           $7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL
         )
         RETURNING id, kind, title, content_md, content_plain, color, captured_at,
                   version, created_at, updated_at, deleted_at, ref_type, ref_id,
                   ref_snapshot, origin`,
        [ownerId, input.title, input.contentMd, input.contentPlain, input.color, input.indexedHash, input.capturedAt],
      )
      const row = result.rows[0]
      if (!row) throw new Error('便签插入后未返回记录')

      await recordMindNoteUndo(client, {
        ownerId,
        contextId: undoContextId,
        action: 'create',
        noteId: Number(row.id),
        beforeSnapshot: null,
        afterSnapshot: mindNoteUndoSnapshot(row),
        baseVersion: 0,
      })

      return toMindNoteReadResponse(row)
    })
  }
}
