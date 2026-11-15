import { sql, type Kysely, type Transaction, type Selectable, type Updateable } from 'kysely'
import { dataContext } from '../contracts/index.js'
import { databaseTime, nowUtc, utc, type Clock } from '../data/codec.js'
import type { Backend } from '../data/repositories.js'
import type { Database, MindNodeTable } from '../data/schema.js'
import { recordForwardUndoOperation } from '../data/undo.js'
import { enqueueMindRagIndex } from './rag-index-job.js'
import type { MindNoteReadResponse } from './note-create.js'
import { MindNoteMutationError, type MindNoteUpdateInput } from './note-mutations.js'

type Row = Selectable<MindNodeTable> & { precise_captured_at?: string | null; precise_deleted_at?: string | null }
const iso = (value: unknown) => new Date(utc(value instanceof Date ? value.toISOString() : value).replace(' ', 'T')).toISOString().replace(/Z$/, '+00:00')
function response(row: Row): MindNoteReadResponse {
  return { id: Number(row.id), kind: row.kind, title: row.title, contentMd: row.content_md ?? '', color: row.color,
    capturedAt: iso(row.captured_at), version: Number(row.version), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    deletedAt: row.deleted_at === null ? null : iso(row.deleted_at), refType: row.ref_type,
    refId: row.ref_id === null ? null : Number(row.ref_id), refSnapshot: typeof row.ref_snapshot === 'string' ? JSON.parse(row.ref_snapshot) : row.ref_snapshot }
}
function snapshotTime(value:unknown) {
  const precise=utc(value instanceof Date?value.toISOString():value).replace(' ','T')
  const fraction=/\.(\d{6})\+00:00$/.exec(precise)?.[1]
  return fraction&&fraction.slice(3)!=='000'?precise:iso(value)
}
function snapshot(row: Row) {
  const note = response(row)
  return { id: note.id, kind: note.kind, title: note.title, content_md: note.contentMd, content_plain: row.content_plain,
    color: note.color, ref_type: note.refType, ref_id: note.refId, ref_snapshot: note.refSnapshot,
    origin: row.origin, captured_at: snapshotTime(row.precise_captured_at??row.captured_at), version: note.version, deleted_at: row.deleted_at===null?null:snapshotTime(row.precise_deleted_at??row.deleted_at) }
}
/** 在同一事务中执行便签 CAS 和 Undo；调用方仅在提交成功后发布事件。 */
export function createSqlMindNoteMutator(db: Kysely<Database>, backend: Backend, clock: Clock = nowUtc) {
  const precise=(field:string)=>backend==='postgres'?sql<string|null>`to_char(${sql.ref(field)} AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00:00'`:sql<string|null>`${sql.ref(field)}`
  const timestamps=()=>[precise('captured_at').as('precise_captured_at'),precise('deleted_at').as('precise_deleted_at')]
  const transact=<T>(work:(tx:Transaction<Database>)=>Promise<T>)=>db.isTransaction?work(db as Transaction<Database>):db.transaction().execute(work)
  async function mutate(rawOwner: string, noteId: number, input: MindNoteUpdateInput | null | 'restore', contextId: string | null) {
    const canonicalOwner = dataContext(rawOwner).ownerId
    const owner = backend === 'sqlite' ? canonicalOwner.replaceAll('-', '') : canonicalOwner
    return transact(async tx => {
      let query = tx.selectFrom('mind_nodes').selectAll().select(timestamps()).where('id', '=', noteId).where('user_id', '=', owner).where('kind', '=', 'note')
      query=input==='restore'?query.where('deleted_at','is not',null):query.where('deleted_at','is',null)
      if (backend === 'postgres') query = query.forUpdate()
      const before = await query.executeTakeFirst()
      if (!before) throw new MindNoteMutationError('便签不存在', 404)
      const fields: Updateable<MindNodeTable> = {}
      if(input==='restore')fields.deleted_at=null
      else if (input) {
        if (input.contentMd !== undefined) { fields.content_md = input.contentMd; fields.content_plain = input.contentPlain; fields.indexed_hash = input.indexedHash; fields.indexed_at = null }
        if (input.title !== undefined) fields.title = input.title
        if (input.color !== undefined) fields.color = input.color
        if (input.capturedAt !== undefined) fields.captured_at = databaseTime(input.capturedAt.toISOString(), backend)
        if (!Object.keys(fields).length) return { note: response(before), changed: false }
        if (input.version !== Number(before.version)) throw new MindNoteMutationError('便签已被其他端修改，请刷新后重试', 409)
      } else fields.deleted_at = databaseTime(clock(), backend)
      const updatedAt = databaseTime(clock(), backend)
      fields.updated_at = updatedAt
      const updating = tx.updateTable('mind_nodes').set(fields).set({ version: sql`version + 1` })
        .where('id', '=', noteId).where('user_id', '=', owner).where('kind', '=', 'note')
        .where('version', '=', Number(before.version))
      const after=await (input==='restore'?updating.where('deleted_at','is not',null):updating.where('deleted_at','is',null)).returningAll().returning(timestamps()).executeTakeFirst()
      if (!after) throw new MindNoteMutationError('便签已被其他端修改，请刷新后重试', 409)
      const context = contextId?.trim().slice(0, 128)
      if (context) {
        const key = `note:${noteId}`
        await recordForwardUndoOperation(tx, backend, { userId: canonicalOwner, contextId: context, resource: 'mind',
          action: input ? 'update' : 'delete', targetRefs: [{ kind: 'note', id: noteId }],
          beforeState: { items: { [key]: snapshot(before) } }, afterState: { items: { [key]: snapshot(after) } },
          baseVersions: { [key]: { version: Number(before.version) } } }, clock)
      }
      await enqueueMindRagIndex(tx, backend, owner, 'note', String(noteId), updatedAt, input === 'restore' ? 'update' : input ? 'update' : 'delete')
      return { note: response(after), changed: true }
    })
  }
  return { restore:(owner:string,id:number,context:string|null)=>mutate(owner,id,'restore',context), update: (owner: string, id: number, input: MindNoteUpdateInput, context: string | null) => mutate(owner, id, input, context),
    async delete(owner: string, id: number, context: string | null): Promise<void> { await mutate(owner, id, null, context) } }
}
