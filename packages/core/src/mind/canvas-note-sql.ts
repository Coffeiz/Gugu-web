import { sql, type Kysely, type Transaction, type Selectable, type Updateable } from 'kysely'
import { dataContext } from '../contracts/index.js'
import { databaseTime, nowUtc, utc, type Clock } from '../data/codec.js'
import type { Backend } from '../data/repositories.js'
import type { Database, MindNodeTable } from '../data/schema.js'
import { recordForwardUndoOperation } from '../data/undo.js'
import { canvasItemResponse, canvasItemSnapshot } from './canvas-item-add-sql.js'
import { mindCanvasNoteContentProjection, MindCanvasNoteMutationError, type MindCanvasNoteMutationRuntime } from './canvas-note.js'

const iso = (value: unknown) => new Date(utc(value instanceof Date ? value.toISOString() : value).replace(' ', 'T')).toISOString().replace(/Z$/, '+00:00')
function response(row: Selectable<MindNodeTable>) {
  const ref = typeof row.ref_snapshot === 'string' ? JSON.parse(row.ref_snapshot) : row.ref_snapshot
  return { id: Number(row.id), kind: row.kind, title: row.title, contentMd: row.content_md ?? '', color: row.color, capturedAt: iso(row.captured_at), version: Number(row.version), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), deletedAt: row.deleted_at === null ? null : iso(row.deleted_at), refType: row.ref_type, refId: row.ref_id === null ? null : Number(row.ref_id), refSnapshot: ref }
}
function snapshot(row: Selectable<MindNodeTable>) { const note = response(row); return { id: note.id, kind: note.kind, title: note.title, content_md: note.contentMd, content_plain: row.content_plain, color: note.color, ref_type: note.refType, ref_id: note.refId, ref_snapshot: note.refSnapshot, origin: row.origin, captured_at: note.capturedAt, version: note.version, deleted_at: note.deletedAt } }
/** 节点、条目和 Undo 同事务，宿主在提交后通知。 */
export function createSqlMindCanvasNoteRuntime(db: Kysely<Database>, backend: Backend, publishChanged: MindCanvasNoteMutationRuntime['publishChanged'], reportFailure?: MindCanvasNoteMutationRuntime['reportFailure'], clock: Clock = nowUtc): MindCanvasNoteMutationRuntime {
  const transact = <T>(work: (tx: Transaction<Database>) => Promise<T>) => db.isTransaction ? work(db as Transaction<Database>) : db.transaction().execute(work)
  const ownerId = (raw: string) => { const canonical = dataContext(raw).ownerId; return { canonical, owner: backend === 'sqlite' ? canonical.replaceAll('-', '') : canonical } }
  return {
    async create(rawOwner, canvasId, input, contextId) {
      const { canonical, owner } = ownerId(rawOwner)
      return transact(async tx => {
        let query = tx.selectFrom('mind_maps').select('id').where('id', '=', canvasId).where('user_id', '=', owner).where('deleted_at', 'is', null)
        if (backend === 'postgres') query = query.forUpdate()
        if (!await query.executeTakeFirst()) throw new MindCanvasNoteMutationError('画布不存在', 404)
        const now = databaseTime(clock(), backend), content = mindCanvasNoteContentProjection(input.contentMd)
        const node = await tx.insertInto('mind_nodes').values({ user_id: owner, kind: 'canvas_note', title: input.title, content_md: input.contentMd, content_plain: content.contentPlain, color: input.color, ref_type: null, ref_id: null, ref_snapshot: null, origin: 'user', indexed_at: null, indexed_hash: content.indexedHash, version: 1, captured_at: now, created_at: now, updated_at: now, deleted_at: null }).returningAll().executeTakeFirstOrThrow()
        const item = await tx.insertInto('mind_canvas_items').values({ user_id: owner, canvas_id: canvasId, node_id: Number(node.id), x: input.x, y: input.y, w: input.w, h: input.h, z: input.z, collapsed: backend === 'sqlite' ? 0 : false, data_json: '{}', created_at: now, updated_at: now, deleted_at: null }).returningAll().executeTakeFirstOrThrow()
        const context = contextId?.trim().slice(0, 128)
        if (context) { const nodeId = Number(node.id), itemId = Number(item.id), nodeKey = `canvas_note:${nodeId}`, itemKey = `canvas_item:${itemId}`; await recordForwardUndoOperation(tx, backend, { userId: canonical, contextId: context, resource: 'mind', action: 'create', targetRefs: [{ kind: 'canvas_note', id: nodeId }, { kind: 'canvas_item', id: itemId }], beforeState: { items: {} }, afterState: { items: { [nodeKey]: snapshot(node), [itemKey]: canvasItemSnapshot(item) } }, baseVersions: { [nodeKey]: { version: 0 }, [itemKey]: {} } }, clock) }
        return canvasItemResponse(tx, owner, item, node)
      })
    },
    async update(rawOwner, nodeId, input, contextId) {
      const { canonical, owner } = ownerId(rawOwner)
      return transact(async tx => {
        let query = tx.selectFrom('mind_nodes').selectAll().where('id', '=', nodeId).where('user_id', '=', owner).where('kind', '=', 'canvas_note').where('deleted_at', 'is', null)
        if (backend === 'postgres') query = query.forUpdate()
        const before = await query.executeTakeFirst()
        if (!before) throw new MindCanvasNoteMutationError('画布便签不存在', 404)
        const patch: Updateable<MindNodeTable> = {}
        if (input.title !== undefined) patch.title = input.title
        if (input.color !== undefined) patch.color = input.color
        if (input.contentMd !== undefined) { const content = mindCanvasNoteContentProjection(input.contentMd); patch.content_md = input.contentMd; patch.content_plain = content.contentPlain; patch.indexed_hash = content.indexedHash; patch.indexed_at = null }
        if (!Object.keys(patch).length) return { note: response(before), changed: false }
        if (input.version !== Number(before.version)) throw new MindCanvasNoteMutationError('画布便签已被其他端修改，请刷新后重试', 409)
        patch.updated_at = databaseTime(clock(), backend)
        const after = await tx.updateTable('mind_nodes').set(patch).set({ version: sql`version + 1` }).where('id', '=', nodeId).where('user_id', '=', owner).where('kind', '=', 'canvas_note').where('version', '=', input.version).where('deleted_at', 'is', null).returningAll().executeTakeFirst()
        if (!after) throw new MindCanvasNoteMutationError('画布便签已被其他端修改，请刷新后重试', 409)
        const context = contextId?.trim().slice(0, 128)
        if (context) { const key = `canvas_note:${nodeId}`; await recordForwardUndoOperation(tx, backend, { userId: canonical, contextId: context, resource: 'mind', action: 'update', targetRefs: [{ kind: 'canvas_note', id: nodeId }], beforeState: { items: { [key]: snapshot(before) } }, afterState: { items: { [key]: snapshot(after) } }, baseVersions: { [key]: { version: Number(before.version) } } }, clock) }
        return { note: response(after), changed: true }
      })
    }, publishChanged, reportFailure,
  }
}
