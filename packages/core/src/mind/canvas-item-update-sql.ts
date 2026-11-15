import type { Kysely, Selectable, Transaction, Updateable } from 'kysely'
import { dataContext } from '../contracts/index.js'
import { databaseTime, nowUtc, type Clock } from '../data/codec.js'
import type { Backend } from '../data/repositories.js'
import type { Database, MindCanvasItemTable, MindNodeTable } from '../data/schema.js'
import { recordForwardUndoOperation } from '../data/undo.js'
import { canvasItemResponse, canvasItemSnapshot } from './canvas-item-add-sql.js'
import { MindCanvasItemMutationError } from './canvas-item-remove.js'
import type { CanvasItemUpdateRuntime } from './canvas-item-update.js'

type Item = Selectable<MindCanvasItemTable>
/** includeDeletedNodes仅由可信适配显式开启；默认Web行为继续过滤节点墓碑。 */
export function createSqlMindCanvasItemUpdateRuntime(db: Kysely<Database>, backend: Backend, publishChanged: CanvasItemUpdateRuntime['publishChanged'], reportFailure?: CanvasItemUpdateRuntime['reportFailure'], clock: Clock = nowUtc, options: { includeDeletedNodes?: boolean } = {}): CanvasItemUpdateRuntime {
  async function work<T>(rawOwner: string, canvasId: number, fn: (tx: Transaction<Database>, owner: string, canonical: string) => Promise<T>) {
    const canonical = dataContext(rawOwner).ownerId, owner = backend === 'sqlite' ? canonical.replaceAll('-', '') : canonical
    const run = async (tx: Transaction<Database>) => {
      let canvas = tx.selectFrom('mind_maps').select('id').where('id', '=', canvasId).where('user_id', '=', owner).where('deleted_at', 'is', null)
      if (backend === 'postgres') canvas = canvas.forUpdate()
      if (!await canvas.executeTakeFirst()) throw new MindCanvasItemMutationError('画布不存在', 404)
      return fn(tx, owner, canonical)
    }
    return db.isTransaction ? run(db as Transaction<Database>) : db.transaction().execute(run)
  }
  async function nodeFor(tx: Transaction<Database>, owner: string, item: Item): Promise<Selectable<MindNodeTable>> {
    let query = tx.selectFrom('mind_nodes').selectAll().where('id', '=', Number(item.node_id)).where('user_id', '=', owner)
    if (!options.includeDeletedNodes) query = query.where('deleted_at', 'is', null)
    if (backend === 'postgres') query = query.forUpdate()
    const node = await query.executeTakeFirst()
    if (!node) throw new MindCanvasItemMutationError('画布贴纸不存在', 404)
    return node
  }
  async function undo(tx: Transaction<Database>, canonical: string, contextId: string | null, before: Item[], after: Item[], grouped: boolean) {
    const context = contextId?.trim().slice(0, 128)
    if (!context) return
    const items = (rows: Item[]) => Object.fromEntries(rows.map(row => [`canvas_item:${row.id}`, canvasItemSnapshot(row)]))
    await recordForwardUndoOperation(tx, backend, { userId: canonical, contextId: context, resource: 'mind', action: 'update', targetRefs: before.map(row => ({ kind: 'canvas_item', id: Number(row.id) })), beforeState: { items: items(before) }, afterState: { items: items(after) }, baseVersions: grouped ? {} : { [`canvas_item:${before[0]!.id}`]: {} } }, clock)
  }
  return {
    update: (ownerId, canvasId, itemId, input, context) => work(ownerId, canvasId, async (tx, owner, canonical) => {
      let query = tx.selectFrom('mind_canvas_items').selectAll().where('id', '=', itemId).where('canvas_id', '=', canvasId).where('user_id', '=', owner).where('deleted_at', 'is', null)
      if (backend === 'postgres') query = query.forUpdate()
      const before = await query.executeTakeFirst()
      if (!before) throw new MindCanvasItemMutationError('画布贴纸不存在', 404)
      const node = await nodeFor(tx, owner, before), patch: Updateable<MindCanvasItemTable> = {}
      if (input.x !== undefined) patch.x = input.x
      if (input.y !== undefined) patch.y = input.y
      if (input.w !== undefined) patch.w = node.kind === 'canvas_note' && input.w !== null ? Math.min(520, Math.max(180, input.w)) : input.w
      if (input.h !== undefined) patch.h = node.kind === 'canvas_note' && input.h !== null ? Math.min(420, Math.max(100, input.h)) : input.h
      if (input.z !== undefined) patch.z = input.z
      if (input.collapsed !== undefined) patch.collapsed = backend === 'sqlite' ? Number(input.collapsed) : input.collapsed
      if (input.dataJson !== undefined) patch.data_json = input.dataJson
      let after = before
      if (Object.keys(patch).length) { patch.updated_at = databaseTime(clock(), backend); after = await tx.updateTable('mind_canvas_items').set(patch).where('id', '=', itemId).where('canvas_id', '=', canvasId).where('user_id', '=', owner).where('deleted_at', 'is', null).returningAll().executeTakeFirstOrThrow() }
      await undo(tx, canonical, context, [before], [after], false)
      return canvasItemResponse(tx, owner, after, node)
    }),
    bringToFront: (ownerId, canvasId, itemId, x, y, context) => work(ownerId, canvasId, async (tx, owner, canonical) => {
      let query = tx.selectFrom('mind_canvas_items').selectAll().where('canvas_id', '=', canvasId).where('user_id', '=', owner).orderBy('id')
      if (backend === 'postgres') query = query.forUpdate()
      const before = await query.execute(), active: Array<{ item: Item; node: Selectable<MindNodeTable> }> = []
      for (const item of before) {
        if (item.deleted_at !== null) continue
        let nodeQuery = tx.selectFrom('mind_nodes').selectAll().where('id', '=', Number(item.node_id)).where('user_id', '=', owner).where('deleted_at', 'is', null)
        if (backend === 'postgres') nodeQuery = nodeQuery.forUpdate()
        const node = await nodeQuery.executeTakeFirst()
        if (node) active.push({ item, node })
      }
      active.sort((a, b) => Number(a.item.z) - Number(b.item.z) || Number(a.item.id) - Number(b.item.id))
      const target = active.find(entry => Number(entry.item.id) === itemId)
      if (!target) throw new MindCanvasItemMutationError('画布贴纸不存在', 404)
      const ordered = [...active.filter(entry => Number(entry.item.id) !== itemId), target], now = databaseTime(clock(), backend)
      let updated: Item | undefined
      for (const [index, entry] of ordered.entries()) {
        const row = await tx.updateTable('mind_canvas_items').set({ z: (index + 1) * 1000, x: Number(entry.item.id) === itemId ? x : entry.item.x, y: Number(entry.item.id) === itemId ? y : entry.item.y, updated_at: now }).where('id', '=', Number(entry.item.id)).where('canvas_id', '=', canvasId).where('user_id', '=', owner).where('deleted_at', 'is', null).returningAll().executeTakeFirstOrThrow()
        if (Number(row.id) === itemId) updated = row
      }
      if (!updated) throw new MindCanvasItemMutationError('画布贴纸不存在', 404)
      const after = await tx.selectFrom('mind_canvas_items').selectAll().where('canvas_id', '=', canvasId).where('user_id', '=', owner).orderBy('id').execute()
      await undo(tx, canonical, context, before, after, true)
      return canvasItemResponse(tx, owner, updated, target.node)
    }), publishChanged, reportFailure,
  }
}
