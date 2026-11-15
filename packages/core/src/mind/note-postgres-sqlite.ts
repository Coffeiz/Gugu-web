import type { Kysely, Transaction } from 'kysely'
import { dataContext } from '../contracts/index.js'
import { databaseTime, nowUtc, utc, type Clock } from '../data/codec.js'
import type { Backend } from '../data/repositories.js'
import type { Database } from '../data/schema.js'
import { recordForwardUndoOperation } from '../data/undo.js'
import { enqueueMindRagIndex } from './rag-index-job.js'
import type { MindNoteCreateInput, MindNoteReadResponse } from './note-create.js'

export type MindDatabase = Database

type MindNoteInsert = (rawOwner: string, input: MindNoteCreateInput, contextId: string | null) => Promise<MindNoteReadResponse>
function noteInserter(db: Kysely<MindDatabase> | Transaction<MindDatabase>, backend: Backend, clock: Clock): MindNoteInsert {
  return async (rawOwner, input, contextId) => {
    const canonicalOwner = dataContext(rawOwner).ownerId
    const owner = backend === 'sqlite' ? canonicalOwner.replaceAll('-', '') : canonicalOwner
    const insert = async (tx: Transaction<MindDatabase>) => {
      const now = databaseTime(clock(), backend)
      const row = await tx.insertInto('mind_nodes').values({
        user_id: owner, kind: 'note', title: input.title, content_md: input.contentMd,
        content_plain: input.contentPlain, color: input.color, ref_type: null, ref_id: null,
        ref_snapshot: null, origin: 'user', indexed_at: null, indexed_hash: input.indexedHash,
        version: 1, captured_at: databaseTime(input.capturedAt.toISOString(), backend),
        created_at: now, updated_at: now, deleted_at: null,
      }).returningAll().executeTakeFirstOrThrow()
      const iso = (value: unknown) => new Date(utc(value instanceof Date ? value.toISOString() : value).replace(' ', 'T')).toISOString().replace(/Z$/, '+00:00')
      const response: MindNoteReadResponse = {
        id: Number(row.id), kind: row.kind, title: row.title, contentMd: row.content_md,
        color: row.color, capturedAt: iso(row.captured_at), version: Number(row.version),
        createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), deletedAt: null,
        refType: null, refId: null, refSnapshot: null,
      }
      await enqueueMindRagIndex(tx, backend, owner, 'note', String(response.id), now, 'create')
      const context = contextId?.trim().slice(0, 128)
      if (context) {
        const ref = `note:${response.id}`
        const snapshot = { id: response.id, kind: response.kind, title: response.title,
          content_md: response.contentMd, content_plain: input.contentPlain, color: response.color,
          ref_type: null, ref_id: null, ref_snapshot: null, origin: 'user',
          captured_at: response.capturedAt, version: response.version, deleted_at: null }
        await recordForwardUndoOperation(tx, backend, {
          userId: canonicalOwner, contextId: context, resource: 'mind', action: 'create',
          targetRefs: [{ kind: 'note', id: response.id }], beforeState: { items: {} },
          afterState: { items: { [ref]: snapshot } }, baseVersions: { [ref]: { version: 0 } },
        }, clock)
      }
      return response
    }
    return db.isTransaction ? insert(db as Transaction<MindDatabase>) : db.transaction().execute(insert)
  }
}

/** 在同一事务中创建便签和 Undo，调用方在提交后发布事件。 */
export function createSqlMindNoteInserter(db: Kysely<MindDatabase>, backend: Backend, clock: Clock = nowUtc): MindNoteInsert {
  if (db.isTransaction) throw new Error('借用事务必须使用便签借用事务入口')
  return noteInserter(db, backend, clock)
}

/** 与操作收据或跨域事务共用同一 SQLite/PG 事务；提交后事件由外层发布。 */
export function createBorrowedSqlMindNoteInserter(tx: Transaction<MindDatabase>, backend: Backend, clock: Clock = nowUtc): MindNoteInsert {
  return noteInserter(tx, backend, clock)
}
