import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import { tablesSql } from '../../src/data/schema.js'
import { createSqlMindNoteInserter, type MindDatabase } from '../../src/mind/note-postgres-sqlite.js'
import { createSqlMindNoteMutator } from '../../src/mind/note-mutations-sql.js'
import { createMindNoteMutations, prepareMindNoteUpdate } from '../../src/mind/note-mutations.js'
import { createMindCanvasRelationDelete } from '../../src/mind/relation-delete-canvas.js'
import { createSqlMindCanvasRelationDeleteRuntime } from '../../src/mind/relation-delete-canvas-sql.js'
import { createMindCanvasRelationCreate } from '../../src/mind/relation-create.js'
import { createSqlMindCanvasRelationCreateRuntime } from '../../src/mind/relation-create-sql.js'
import { createMindGlobalRelationDelete } from '../../src/mind/relation-delete-global.js'
import { createSqlMindGlobalRelationDeleteRuntime } from '../../src/mind/relation-delete-global-sql.js'
import { applyMindUndoInTransaction, MindUndoConflict } from '../../src/mind/undo-adapter.js'
import { createSqlMindNoteReader } from '../../src/mind/note-read.js'
import { createSqlMindCanvasReader } from '../../src/mind/canvas-read.js'
import { createMindRefNodeCreator } from '../../src/mind/ref-node-create.js'
import { createSqlMindRefNodeCreateRuntime } from '../../src/mind/ref-node-create-sql.js'
import { createMindCanvasNoteMutations } from '../../src/mind/canvas-note.js'
import { createSqlMindCanvasNoteRuntime } from '../../src/mind/canvas-note-sql.js'
import { createMindCanvasItemUpdate } from '../../src/mind/canvas-item-update.js'
import { createSqlMindCanvasItemUpdateRuntime } from '../../src/mind/canvas-item-update-sql.js'
import { createMindCanvasItemAdd } from '../../src/mind/canvas-item-add.js'
import { createSqlMindCanvasItemAddRuntime } from '../../src/mind/canvas-item-add-sql.js'
import { createMindCanvasItemRemove } from '../../src/mind/canvas-item-remove.js'
import { createSqlMindCanvasItemRemoveRuntime } from '../../src/mind/canvas-item-remove-sql.js'
import { createMindCanvasDelete } from '../../src/mind/canvas-delete.js'
import { createSqlMindCanvasDeleteRuntime } from '../../src/mind/canvas-delete-sql.js'
import { createMindCanvasUpdate } from '../../src/mind/canvas-update.js'
import { createSqlMindCanvasUpdateRuntime } from '../../src/mind/canvas-update-sql.js'
import { createMindCanvasCreation } from '../../src/mind/canvas-create.js'
import { createSqlMindCanvasCreateRuntime } from '../../src/mind/canvas-create-sql.js'
import { prepareMindNoteCreate } from '../../src/mind/note-create.js'

export async function contract(db: Kysely<MindDatabase>, backend: 'sqlite' | 'postgres') {
  await sql.raw(tablesSql(backend).ragJobs).execute(db)
  const owner = randomUUID(), other = randomUUID()
  const insert = createSqlMindNoteInserter(db, backend, () => '2026-11-14T10:00:00.000Z')
  const input = prepareMindNoteCreate({ contentMd: '# 标题\n正文', title: '索引', capturedAt: '2026-11-13T00:00:00Z' }, new Date('2026-11-14T10:00:00Z'))
  const note = await insert(owner, input, 'tab')
  assert.equal(note.contentMd, '# 标题\n正文')
  assert.equal(note.capturedAt, '2026-11-13T00:00:00.000+00:00')
  const storedOwner = backend === 'sqlite' ? owner.replaceAll('-', '') : owner
  const row = await db.selectFrom('mind_nodes').selectAll().where('id', '=', note.id).executeTakeFirstOrThrow()
  assert.equal(row.user_id, storedOwner)
  assert.equal(row.content_plain, '标题\n正文')
  const undo = await db.selectFrom('undo_operations').selectAll().where('user_id', '=', storedOwner).executeTakeFirstOrThrow()
  const after = typeof undo.after_state === 'string' ? JSON.parse(undo.after_state) : undo.after_state as any
  assert.equal(after.items[`note:${note.id}`].content_md, '# 标题\n正文')
  await db.updateTable('undo_operations').set({ status: 'undone' }).where('id', '=', undo.id).execute()
  await insert(other, input, null)
  assert.equal((await db.selectFrom('undo_operations').selectAll().execute()).length, 1)
  assert.equal((await db.selectFrom('undo_operations').select('status').where('id', '=', undo.id).executeTakeFirstOrThrow()).status, 'undone')
  await insert(owner, input, 'tab')
  assert.equal((await db.selectFrom('undo_operations').select('status').where('id', '=', undo.id).executeTakeFirstOrThrow()).status, 'expired')
  const mutator = createSqlMindNoteMutator(db, backend, () => '2026-11-14T11:00:00.000Z')
  await assert.rejects(mutator.update(other, note.id, { version: 1, title: '越权' }, 'tab'), { statusCode: 404 })
  await assert.rejects(mutator.update(owner, note.id, { version: 9, title: '冲突' }, 'tab'), { statusCode: 409 })
  assert.equal((await mutator.update(owner, note.id, { version: 9 }, 'tab')).changed, false)
  const updateInput = prepareMindNoteUpdate({ version: 1, contentMd: '**新正文**', title: '新标题' })
  const updated = await mutator.update(owner, note.id, updateInput, 'tab')
  assert.equal(updated.note.version, 2)
  assert.equal(updated.note.contentMd, '**新正文**')
  const updatedRow = await db.selectFrom('mind_nodes').selectAll().where('id', '=', note.id).executeTakeFirstOrThrow()
  assert.equal(updatedRow.content_plain, '新正文')
  assert.equal(updatedRow.indexed_hash, updateInput.indexedHash)
  assert.equal(updatedRow.indexed_at, null)
  const updateUndo = await db.selectFrom('undo_operations').selectAll().where('action', '=', 'update').executeTakeFirstOrThrow()
  const beforeUpdate = typeof updateUndo.before_state === 'string' ? JSON.parse(updateUndo.before_state) : updateUndo.before_state as any
  assert.equal(beforeUpdate.items[`note:${note.id}`].content_md, '# 标题\n正文')
  const afterUpdate = typeof updateUndo.after_state === 'string' ? JSON.parse(updateUndo.after_state) : updateUndo.after_state as any
  assert.equal(afterUpdate.items[`note:${note.id}`].content_plain, '新正文')
  const events: string[] = []
  const app = createMindNoteMutations({ ...mutator,
    async publishUpdated() { events.push('updated'); throw new Error('notification failure') },
    async publishDeleted() { events.push('deleted') },
    reportFailure() { events.push('reported') },
  })
  await app.update(owner, note.id, { version: 2, color: 'blue' }, { undoContextId: 'tab', clientId: null })
  assert.deepEqual(events, ['updated', 'reported'])
  await app.update(owner, note.id, { version: 0 }, { undoContextId: 'tab', clientId: null })
  assert.deepEqual(events, ['updated', 'reported'])
  await app.delete(owner, note.id, { undoContextId: 'tab', clientId: null })
  assert.deepEqual(events, ['updated', 'reported', 'deleted'])
  await assert.rejects(mutator.delete(owner, note.id, 'tab'), { statusCode: 404 })
  const deleteUndo = await db.selectFrom('undo_operations').selectAll().where('action', '=', 'delete').executeTakeFirstOrThrow()
  const afterDelete = typeof deleteUndo.after_state === 'string' ? JSON.parse(deleteUndo.after_state) : deleteUndo.after_state as any
  assert.equal(afterDelete.items[`note:${note.id}`].version, 4)
  assert.equal(afterDelete.items[`note:${note.id}`].deleted_at, '2026-11-14T11:00:00.000+00:00')
  const second = await db.selectFrom('mind_nodes').selectAll().where('user_id', '=', storedOwner).where('deleted_at', 'is', null).executeTakeFirstOrThrow()
  await sql.raw(tablesSql(backend).projects).execute(db)
  await sql.raw(tablesSql(backend).mindMaps).execute(db)
  const archived = backend === 'sqlite' ? 0 : false
  await sql`INSERT INTO projects (user_id, name, status, color, progress, stages_json, version, archived, created_at, updated_at)
    VALUES (${storedOwner}, '项目', 'active', 'blue', 0, '[]', 1, ${archived}, '2026-11-14T12:00:00Z', '2026-11-14T12:00:00Z')`.execute(db)
  const canvasEvents: string[] = []
  const canvasRuntime = createSqlMindCanvasCreateRuntime(db, backend, async () => { canvasEvents.push('published'); throw new Error('notification') }, () => { canvasEvents.push('reported') }, () => '2026-11-14T12:00:00.000Z')
  const createCanvas = createMindCanvasCreation(canvasRuntime)
  await assert.rejects(createCanvas(other, { projectId: 1 }, { undoContextId: 'canvas', clientId: null }), { statusCode: 404 })
  const canvas = await createCanvas(owner, { projectId: 1, title: '  画布  ' }, { undoContextId: 'canvas', clientId: 'device' })
  assert.equal(canvas.title, '画布')
  assert.equal(canvas.projectId, 1)
  assert.equal(canvas.createdAt, '2026-11-14T12:00:00.000+00:00')
  assert.deepEqual(canvasEvents, ['published', 'reported'])
  const canvasUndo = await db.selectFrom('undo_operations').selectAll().where('undo_context_id', '=', 'canvas').executeTakeFirstOrThrow()
  const canvasAfter = typeof canvasUndo.after_state === 'string' ? JSON.parse(canvasUndo.after_state) : canvasUndo.after_state as any
  assert.equal(canvasAfter.items[`canvas:${canvas.id}`].project_id, 1)
  const updateEvents: string[] = []
  const updateCanvas = createMindCanvasUpdate(createSqlMindCanvasUpdateRuntime(db, backend, async () => { updateEvents.push('published'); throw new Error('notification') }, () => { updateEvents.push('reported') }, () => '2026-11-14T13:00:00.000Z'))
  await assert.rejects(updateCanvas(other, canvas.id, { title: '越权' }, { undoContextId: 'canvas-update', clientId: null }), { statusCode: 404 })
  await assert.rejects(updateCanvas(owner, canvas.id, { data: [] }, { undoContextId: 'canvas-update', clientId: null }), { statusCode: 422 })
  const changedCanvas = await updateCanvas(owner, canvas.id, { title: '  新标题  ', data: { zoom: 1.5 } }, { undoContextId: 'canvas-update', clientId: 'device' })
  assert.equal(changedCanvas.title, '新标题')
  assert.deepEqual(changedCanvas.data, { zoom: 1.5 })
  assert.equal(changedCanvas.updatedAt, '2026-11-14T13:00:00.000+00:00')
  assert.deepEqual(updateEvents, ['published', 'reported'])
  const canvasUpdateUndo = await db.selectFrom('undo_operations').selectAll().where('undo_context_id', '=', 'canvas-update').executeTakeFirstOrThrow()
  const canvasBefore = typeof canvasUpdateUndo.before_state === 'string' ? JSON.parse(canvasUpdateUndo.before_state) : canvasUpdateUndo.before_state as any
  const canvasUpdated = typeof canvasUpdateUndo.after_state === 'string' ? JSON.parse(canvasUpdateUndo.after_state) : canvasUpdateUndo.after_state as any
  assert.equal(canvasBefore.items[`canvas:${canvas.id}`].title, '画布')
  assert.equal(canvasUpdated.items[`canvas:${canvas.id}`].data_json, '{\"zoom\":1.5}')
  await sql.raw(tablesSql(backend).mindItems).execute(db)
  await sql.raw(tablesSql(backend).mindRelations).execute(db)
  await sql`CREATE UNIQUE INDEX uq_mind_relation_legacy ON mind_relations(user_id, src_node_id, dst_node_id, rel_type, edge_key) WHERE canvas_id IS NULL`.execute(db)
  const deleteCanvas = createMindCanvasDelete(createSqlMindCanvasDeleteRuntime(db, backend, async () => {}, undefined, () => '2026-11-14T14:00:00.000Z'))
  const victim = await createCanvas(owner, { title: '删除画布' }, { undoContextId: null, clientId: null })
  const canvasNote = await insert(owner, input, null)
  await db.updateTable('mind_nodes').set({ kind: 'canvas_note' }).where('id', '=', canvasNote.id).execute()
  const bool = backend === 'sqlite' ? 0 : false
  const stamp = '2026-11-13T00:00:00Z'
  await sql`INSERT INTO mind_canvas_items (user_id, canvas_id, node_id, x, y, z, collapsed, data_json, created_at, updated_at) VALUES (${storedOwner}, ${victim.id}, ${canvasNote.id}, 1, 2, 0, ${bool}, '{}', ${stamp}, ${stamp})`.execute(db)
  await sql`INSERT INTO mind_relations (user_id, canvas_id, src_node_id, dst_node_id, rel_type, edge_key, origin, status, created_at, updated_at, deleted_at) VALUES (${storedOwner}, ${victim.id}, ${canvasNote.id}, ${note.id}, 'related', '', 'user', 'confirmed', ${stamp}, ${stamp}, ${stamp})`.execute(db)
  await sql`INSERT INTO mind_canvas_items (user_id, canvas_id, node_id, x, y, z, collapsed, data_json, created_at, updated_at, deleted_at) VALUES (${storedOwner}, ${victim.id}, ${note.id}, 3, 4, 0, ${bool}, '{}', ${stamp}, ${stamp}, ${stamp})`.execute(db)
  await sql`INSERT INTO mind_relations (user_id, canvas_id, src_node_id, dst_node_id, rel_type, edge_key, origin, status, created_at, updated_at) VALUES (${storedOwner}, ${victim.id}, ${note.id}, ${canvasNote.id}, 'related', '', 'user', 'confirmed', ${stamp}, ${stamp})`.execute(db)
  await assert.rejects(deleteCanvas(other, victim.id, { undoContextId: 'delete-canvas', clientId: null }), { statusCode: 404 })
  await deleteCanvas(owner, victim.id, { undoContextId: 'delete-canvas', clientId: null })
  const deleteRecord = await db.selectFrom('undo_operations').selectAll().where('undo_context_id', '=', 'delete-canvas').executeTakeFirstOrThrow()
  const deleteBefore = typeof deleteRecord.before_state === 'string' ? JSON.parse(deleteRecord.before_state) : deleteRecord.before_state as any
  const deleteAfter = typeof deleteRecord.after_state === 'string' ? JSON.parse(deleteRecord.after_state) : deleteRecord.after_state as any
  assert.equal(Object.keys(deleteBefore.items).length, 6)
  assert.equal(deleteBefore.items[`canvas_note:${canvasNote.id}`].content_md, input.contentMd)
  assert.equal(deleteAfter.items[`canvas_note:${canvasNote.id}`].deleted_at, null)
  assert.equal(deleteAfter.items['canvas_item:1'].deleted_at, '2026-11-14T14:00:00.000+00:00')
  assert.equal(deleteBefore.items['canvas_item:2'].deleted_at, '2026-11-13T00:00:00.000+00:00')
  assert.equal(deleteAfter.items['canvas_item:2'].deleted_at, '2026-11-14T14:00:00.000+00:00')
  assert.equal(deleteBefore.items['relation:2'].deleted_at, null)
  assert.equal(deleteAfter.items['relation:2'].deleted_at, '2026-11-14T14:00:00.000+00:00')
  assert.equal(deleteAfter.items['relation:1'].deleted_at, '2026-11-13T00:00:00.000+00:00')
  assert.deepEqual(deleteAfter.items[`canvas_note:${canvasNote.id}`], deleteBefore.items[`canvas_note:${canvasNote.id}`])
  assert.equal((await db.selectFrom('mind_nodes').select('deleted_at').where('id', '=', canvasNote.id).executeTakeFirstOrThrow()).deleted_at, null)
  await sql`INSERT INTO mind_canvas_items (user_id, canvas_id, node_id, x, y, z, collapsed, data_json, created_at, updated_at) VALUES (${storedOwner}, ${canvas.id}, ${canvasNote.id}, 1, 2, 0, ${bool}, '{}', ${stamp}, ${stamp})`.execute(db)
  await sql`INSERT INTO mind_canvas_items (user_id, canvas_id, node_id, x, y, z, collapsed, data_json, created_at, updated_at, deleted_at) VALUES (${storedOwner}, ${canvas.id}, ${note.id}, 3, 4, 0, ${bool}, '{}', ${stamp}, ${stamp}, ${stamp})`.execute(db)
  await sql`INSERT INTO mind_relations (user_id, canvas_id, src_node_id, dst_node_id, rel_type, edge_key, origin, status, created_at, updated_at) VALUES (${storedOwner}, ${canvas.id}, ${canvasNote.id}, ${note.id}, 'related', '', 'user', 'confirmed', ${stamp}, ${stamp})`.execute(db)
  await sql`INSERT INTO mind_relations (user_id, canvas_id, src_node_id, dst_node_id, rel_type, edge_key, origin, status, created_at, updated_at, deleted_at) VALUES (${storedOwner}, ${canvas.id}, ${note.id}, ${canvasNote.id}, 'related', '', 'user', 'confirmed', ${stamp}, ${stamp}, ${stamp})`.execute(db)
  const itemsBeforeRollback = (await sql`SELECT * FROM mind_canvas_items WHERE canvas_id = ${canvas.id} ORDER BY id`.execute(db)).rows
  const relationsBeforeRollback = (await sql`SELECT * FROM mind_relations WHERE canvas_id = ${canvas.id} ORDER BY id`.execute(db)).rows
  const noteBeforeRollback = await db.selectFrom('mind_nodes').selectAll().where('id', '=', canvasNote.id).executeTakeFirstOrThrow()
  const globalRelation = (await sql<{ id: number }>`INSERT INTO mind_relations (user_id, canvas_id, src_node_id, dst_node_id, rel_type, edge_key, origin, status, created_at, updated_at) VALUES (${storedOwner}, NULL, ${canvasNote.id}, ${note.id}, 'related', '', 'user', 'confirmed', ${stamp}, ${stamp}) RETURNING id`.execute(db)).rows[0]!
  const globalEvents: string[] = []
  const deleteGlobal = createMindGlobalRelationDelete(createSqlMindGlobalRelationDeleteRuntime(db, backend, async () => { globalEvents.push('published'); throw new Error('notification') }, () => { globalEvents.push('reported') }, () => '2026-11-14T15:00:00.000Z'))
  const globalMetadata = { undoContextId: 'global-relation', clientId: null, mutationId: null }
  await assert.rejects(deleteGlobal(other, Number(globalRelation.id), globalMetadata), { statusCode: 404 })
  await assert.rejects(deleteGlobal(owner, 1, globalMetadata), { statusCode: 404 })
  await deleteGlobal(owner, Number(globalRelation.id), globalMetadata)
  assert.deepEqual(globalEvents, ['published', 'reported'])
  await assert.rejects(deleteGlobal(owner, Number(globalRelation.id), globalMetadata), { statusCode: 404 })
  const globalUndo = await db.selectFrom('undo_operations').selectAll().where('undo_context_id', '=', 'global-relation').executeTakeFirstOrThrow()
  const globalBefore = typeof globalUndo.before_state === 'string' ? JSON.parse(globalUndo.before_state) : globalUndo.before_state as any
  const globalAfter = typeof globalUndo.after_state === 'string' ? JSON.parse(globalUndo.after_state) : globalUndo.after_state as any
  assert.equal(globalBefore.items[`relation:${globalRelation.id}`].canvas_id, null)
  assert.equal(globalBefore.items[`relation:${globalRelation.id}`].deleted_at, null)
  assert.equal(globalAfter.items[`relation:${globalRelation.id}`].deleted_at, '2026-11-14T15:00:00.000+00:00')
  const rollbackGlobal = (await sql<{ id: number }>`INSERT INTO mind_relations (user_id, canvas_id, src_node_id, dst_node_id, rel_type, edge_key, origin, status, created_at, updated_at) VALUES (${storedOwner}, NULL, ${note.id}, ${canvasNote.id}, 'related', '', 'user', 'confirmed', ${stamp}, ${stamp}) RETURNING id`.execute(db)).rows[0]!
  const itemCanvas = await createCanvas(owner, { title: '条目画布' }, { undoContextId: null, clientId: null })
  const removalItem = (await sql<{ id: number }>`INSERT INTO mind_canvas_items (user_id, canvas_id, node_id, x, y, z, collapsed, data_json, created_at, updated_at) VALUES (${storedOwner}, ${itemCanvas.id}, ${canvasNote.id}, 1, 2, 0, ${bool}, '{}', ${stamp}, ${stamp}) RETURNING id`.execute(db)).rows[0]!
  const removalRelations = await sql<{ id: number }>`INSERT INTO mind_relations (user_id, canvas_id, src_node_id, dst_node_id, rel_type, edge_key, origin, status, created_at, updated_at, deleted_at) VALUES (${storedOwner}, ${itemCanvas.id}, ${canvasNote.id}, ${note.id}, 'related', '', 'user', 'confirmed', ${stamp}, ${stamp}, NULL), (${storedOwner}, ${itemCanvas.id}, ${note.id}, ${canvasNote.id}, 'related', '', 'user', 'confirmed', ${stamp}, ${stamp}, ${stamp}) RETURNING id`.execute(db)
  const removalEvents: string[] = []
  const removeItem = createMindCanvasItemRemove(createSqlMindCanvasItemRemoveRuntime(db, backend, async () => { removalEvents.push('published'); throw new Error('notification') }, () => { removalEvents.push('reported') }, () => '2026-11-14T16:00:00.000Z'))
  const removeMetadata = { undoContextId: 'remove-item', clientId: null, mutationId: null }
  await assert.rejects(removeItem(other, itemCanvas.id, Number(removalItem.id), removeMetadata), { statusCode: 404 })
  await assert.rejects(removeItem(owner, canvas.id, Number(removalItem.id), removeMetadata), { statusCode: 404 })
  await removeItem(owner, itemCanvas.id, Number(removalItem.id), removeMetadata)
  await assert.rejects(removeItem(owner, itemCanvas.id, Number(removalItem.id), removeMetadata), { statusCode: 404 })
  assert.deepEqual(removalEvents, ['published', 'reported'])
  const itemCanvasData = await db.selectFrom('mind_maps').select('data_json').where('id', '=', itemCanvas.id).executeTakeFirstOrThrow()
  assert.deepEqual(JSON.parse(itemCanvasData.data_json).detachedRelationIds, removalRelations.rows.map(row => Number(row.id)).sort((a, b) => a - b))
  const untouchedRelations = await db.selectFrom('mind_relations').selectAll().where('canvas_id', '=', itemCanvas.id).orderBy('id').execute()
  assert.equal(untouchedRelations[0]!.deleted_at, null)
  assert.ok(untouchedRelations[1]!.deleted_at)
  const itemUndo = await db.selectFrom('undo_operations').selectAll().where('undo_context_id', '=', 'remove-item').executeTakeFirstOrThrow()
  const itemBefore = typeof itemUndo.before_state === 'string' ? JSON.parse(itemUndo.before_state) : itemUndo.before_state as any
  const itemAfter = typeof itemUndo.after_state === 'string' ? JSON.parse(itemUndo.after_state) : itemUndo.after_state as any
  assert.equal(itemBefore.items[`canvas_item:${removalItem.id}`].deleted_at, null)
  assert.equal(itemAfter.items[`canvas_item:${removalItem.id}`].deleted_at, '2026-11-14T16:00:00.000+00:00')
  const canvasDataBeforeRemoveRollback = await db.selectFrom('mind_maps').selectAll().where('id', '=', canvas.id).executeTakeFirstOrThrow()
  const relationCanvas = await createCanvas(owner, { title: '关系画布' }, { undoContextId: null, clientId: null })
  await sql`INSERT INTO mind_canvas_items (user_id, canvas_id, node_id, x, y, z, collapsed, data_json, created_at, updated_at) VALUES (${storedOwner}, ${relationCanvas.id}, ${canvasNote.id}, 1, 2, 0, ${bool}, '{}', ${stamp}, ${stamp}), (${storedOwner}, ${relationCanvas.id}, ${Number(second.id)}, 3, 4, 0, ${bool}, '{}', ${stamp}, ${stamp})`.execute(db)
  const createRelationEvents: string[] = []
  const createRelation = createMindCanvasRelationCreate(createSqlMindCanvasRelationCreateRuntime(db, backend, async () => { createRelationEvents.push('published'); throw new Error('notification') }, () => { createRelationEvents.push('reported') }, () => '2026-11-14T17:00:00.000Z'))
  const relationMetadata = { undoContextId: 'create-relation', clientId: null, mutationId: null }
  const relationInput = { canvasId: relationCanvas.id, srcNodeId: canvasNote.id, dstNodeId: Number(second.id) }
  await assert.rejects(createRelation(owner, { srcNodeId: canvasNote.id, dstNodeId: Number(second.id) }, relationMetadata), { statusCode: 422 })
  await assert.rejects(createRelation(owner, { ...relationInput, canvasId: null }, relationMetadata), { statusCode: 422 })
  await assert.rejects(createRelation(other, relationInput, relationMetadata), { statusCode: 404 })
  await assert.rejects(createRelation(owner, { ...relationInput, dstNodeId: canvasNote.id }, relationMetadata), { statusCode: 422 })
  await assert.rejects(createRelation(owner, { ...relationInput, dstNodeId: note.id }, relationMetadata), { statusCode: 422 })
  const createdRelation = await createRelation(owner, relationInput, relationMetadata)
  assert.deepEqual([createdRelation.srcNodeId, createdRelation.dstNodeId], [Math.min(canvasNote.id, Number(second.id)), Math.max(canvasNote.id, Number(second.id))])
  const duplicateRelation = await createRelation(owner, { ...relationInput, srcNodeId: relationInput.dstNodeId, dstNodeId: relationInput.srcNodeId }, relationMetadata)
  assert.equal(duplicateRelation.id, createdRelation.id)
  const parallelRelation = await createRelation(owner, { ...relationInput, allowParallel: true }, relationMetadata)
  assert.notEqual(parallelRelation.id, createdRelation.id)
  assert.deepEqual(createRelationEvents, ['published', 'reported', 'published', 'reported', 'published', 'reported'])
  await db.updateTable('mind_relations').set({ deleted_at: stamp }).where('id', '=', createdRelation.id).execute()
  const revivedRelation = await createRelation(owner, relationInput, relationMetadata)
  assert.equal(revivedRelation.id, createdRelation.id)
  if (backend === 'postgres') {
    await db.updateTable('mind_relations').set({ deleted_at: stamp }).where('id', '=', createdRelation.id).execute()
    const concurrent = await Promise.all(Array.from({ length: 3 }, () => createRelation(owner, relationInput, { undoContextId: null, clientId: null, mutationId: null })))
    assert.deepEqual(concurrent.map(row => row.id), [createdRelation.id, createdRelation.id, createdRelation.id])
  }
  const relationUndos = await db.selectFrom('undo_operations').selectAll().where('undo_context_id', '=', 'create-relation').orderBy('created_at').execute()
  assert.equal(relationUndos.length, 4)
  const restoreSnapshots = relationUndos.map(row => typeof row.before_state === 'string' ? JSON.parse(row.before_state) : row.before_state as any)
  assert.ok(restoreSnapshots.some(state => state.items[`relation:${createdRelation.id}`]?.deleted_at === '2026-11-13T00:00:00.000+00:00'))
  const relationDeleteEvents: string[] = []
  const deleteRelation = createMindCanvasRelationDelete(createSqlMindCanvasRelationDeleteRuntime(db, backend, async () => { relationDeleteEvents.push('published'); throw new Error('notification') }, () => { relationDeleteEvents.push('reported') }, () => '2026-11-14T18:00:00.000Z'))
  const relationDeleteMetadata = { undoContextId: 'delete-canvas-relation', clientId: null, mutationId: null }
  await assert.rejects(deleteRelation(other, relationCanvas.id, parallelRelation.id, relationDeleteMetadata), { statusCode: 404 })
  await assert.rejects(deleteRelation(owner, canvas.id, parallelRelation.id, relationDeleteMetadata), { statusCode: 404 })
  await assert.rejects(deleteRelation(owner, relationCanvas.id, Number(rollbackGlobal.id), relationDeleteMetadata), { statusCode: 404 })
  await deleteRelation(owner, relationCanvas.id, parallelRelation.id, relationDeleteMetadata)
  await assert.rejects(deleteRelation(owner, relationCanvas.id, parallelRelation.id, relationDeleteMetadata), { statusCode: 404 })
  assert.deepEqual(relationDeleteEvents, ['published', 'reported'])
  const relationDeleteUndo = await db.selectFrom('undo_operations').selectAll().where('undo_context_id', '=', 'delete-canvas-relation').executeTakeFirstOrThrow()
  const relationDeleteBefore = typeof relationDeleteUndo.before_state === 'string' ? JSON.parse(relationDeleteUndo.before_state) : relationDeleteUndo.before_state as any
  const relationDeleteAfter = typeof relationDeleteUndo.after_state === 'string' ? JSON.parse(relationDeleteUndo.after_state) : relationDeleteUndo.after_state as any
  assert.equal(relationDeleteBefore.items[`relation:${parallelRelation.id}`].deleted_at, null)
  assert.equal(relationDeleteAfter.items[`relation:${parallelRelation.id}`].deleted_at, '2026-11-14T18:00:00.000+00:00')
  if (backend === 'postgres') {
    const concurrentDeletes = await Promise.allSettled(Array.from({ length: 2 }, () => deleteRelation(owner, relationCanvas.id, createdRelation.id, { undoContextId: null, clientId: null, mutationId: null })))
    assert.equal(concurrentDeletes.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(concurrentDeletes.filter(result => result.status === 'rejected' && result.reason.statusCode === 404).length, 1)
  }
  const rollbackRelation = await createRelation(owner, { ...relationInput, allowParallel: true }, { undoContextId: null, clientId: null, mutationId: null })
  const itemAddEvents: string[] = []
  const addItem = createMindCanvasItemAdd(createSqlMindCanvasItemAddRuntime(db, backend, async () => { itemAddEvents.push('published'); throw new Error('notification') }, () => { itemAddEvents.push('reported') }, () => '2026-11-14T19:00:00.000Z'))
  const addMetadata = { undoContextId: 'add-item', clientId: null, mutationId: null }
  await assert.rejects(addItem(other, itemCanvas.id, { nodeId: canvasNote.id }, addMetadata), { statusCode: 404 })
  await assert.rejects(addItem(owner, itemCanvas.id, { nodeId: note.id }, addMetadata), { statusCode: 404 })
  const restoredItem = await addItem(owner, itemCanvas.id, { nodeId: canvasNote.id, x: 22, data: { label: '示例' } }, addMetadata)
  assert.equal(restoredItem.id, Number(removalItem.id))
  assert.equal(restoredItem.x, 22)
  assert.deepEqual(restoredItem.data, { label: '示例' })
  const duplicateItem = await addItem(owner, itemCanvas.id, { nodeId: canvasNote.id, x: 99 }, addMetadata)
  assert.equal(duplicateItem.id, restoredItem.id)
  assert.equal(duplicateItem.x, 22)
  assert.deepEqual(itemAddEvents, ['published', 'reported'])
  assert.equal((await db.selectFrom('undo_operations').selectAll().where('undo_context_id', '=', 'add-item').execute()).length, 1)
  if (backend === 'postgres') {
    const results = await Promise.all(Array.from({ length: 3 }, () => addItem(owner, itemCanvas.id, { nodeId: Number(second.id) }, { undoContextId: null, clientId: null, mutationId: null })))
    assert.equal(new Set(results.map(item => item.id)).size, 1)
    await db.deleteFrom('mind_canvas_items').where('canvas_id', '=', itemCanvas.id).where('node_id', '=', Number(second.id)).execute()
  }
  const itemUpdateEvents: string[] = []
  const itemUpdate = createMindCanvasItemUpdate(createSqlMindCanvasItemUpdateRuntime(db, backend, async () => { itemUpdateEvents.push('published'); throw new Error('notification') }, () => { itemUpdateEvents.push('reported') }, () => '2026-11-14T20:00:00.000Z'))
  const itemUpdateMetadata = { undoContextId: 'update-item', clientId: null, mutationId: null }
  const relationItems = await db.selectFrom('mind_canvas_items').selectAll().where('canvas_id', '=', relationCanvas.id).orderBy('id').execute()
  const firstItem = relationItems.find(row => Number(row.node_id) === canvasNote.id)!
  const secondItem = relationItems.find(row => Number(row.node_id) === Number(second.id))!
  await assert.rejects(itemUpdate.update(other, relationCanvas.id, Number(firstItem.id), { x: 4 }, itemUpdateMetadata), { statusCode: 404 })
  await assert.rejects(itemUpdate.update(owner, itemCanvas.id, Number(firstItem.id), { x: 4 }, itemUpdateMetadata), { statusCode: 404 })
  const resized = await itemUpdate.update(owner, relationCanvas.id, Number(firstItem.id), { x: 5, w: 100, h: 999, collapsed: true }, itemUpdateMetadata)
  assert.deepEqual([resized.x, resized.w, resized.h, resized.collapsed], [5, 180, 420, true])
  await itemUpdate.update(owner, relationCanvas.id, Number(firstItem.id), {}, itemUpdateMetadata)
  assert.equal((await db.selectFrom('undo_operations').selectAll().where('undo_context_id', '=', 'update-item').execute()).length, 2)
  await sql`INSERT INTO mind_canvas_items (user_id, canvas_id, node_id, x, y, z, collapsed, data_json, created_at, updated_at, deleted_at) VALUES (${storedOwner}, ${relationCanvas.id}, ${note.id}, 7, 8, 5, ${bool}, '{}', ${stamp}, ${stamp}, ${stamp})`.execute(db)
  const front = await itemUpdate.bringToFront(owner, relationCanvas.id, Number(firstItem.id), { x: 40, y: 50 }, { ...itemUpdateMetadata, undoContextId: 'front-item' })
  assert.deepEqual([front.x, front.y, front.z], [40, 50, 2000])
  assert.equal((await db.selectFrom('mind_canvas_items').select('z').where('id', '=', Number(secondItem.id)).executeTakeFirstOrThrow()).z, 1000)
  const frontUndo = await db.selectFrom('undo_operations').selectAll().where('undo_context_id', '=', 'front-item').executeTakeFirstOrThrow()
  const frontBefore = typeof frontUndo.before_state === 'string' ? JSON.parse(frontUndo.before_state) : frontUndo.before_state as any
  assert.equal(Object.keys(frontBefore.items).length, 3)
  assert.deepEqual(itemUpdateEvents, ['published', 'reported', 'published', 'reported', 'published', 'reported'])
  const canvasNoteEvents: string[] = []
  const canvasNoteOps = createMindCanvasNoteMutations(createSqlMindCanvasNoteRuntime(db, backend, async () => { canvasNoteEvents.push('published'); throw new Error('notification') }, () => { canvasNoteEvents.push('reported') }, () => '2026-11-14T21:00:00.000Z'))
  const canvasNoteMetadata = { undoContextId: 'canvas-note-create', clientId: null, mutationId: null }
  await assert.rejects(canvasNoteOps.create(other, relationCanvas.id, {}, canvasNoteMetadata), { statusCode: 404 })
  const newCanvasNote = await canvasNoteOps.create(owner, relationCanvas.id, { title: '  ', contentMd: '# 标题\n正文', w: 100, h: 999 }, canvasNoteMetadata)
  assert.equal(newCanvasNote.node.title, '新便签')
  assert.deepEqual([newCanvasNote.w, newCanvasNote.h], [180, 420])
  const newNode = await db.selectFrom('mind_nodes').selectAll().where('id', '=', newCanvasNote.nodeId).executeTakeFirstOrThrow()
  assert.equal(newNode.content_plain, '标题\n正文')
  const createNoteUndo = await db.selectFrom('undo_operations').selectAll().where('undo_context_id', '=', 'canvas-note-create').executeTakeFirstOrThrow()
  const createNoteAfter = typeof createNoteUndo.after_state === 'string' ? JSON.parse(createNoteUndo.after_state) : createNoteUndo.after_state as any
  assert.equal(Object.keys(createNoteAfter.items).length, 2)
  assert.equal(createNoteAfter.items[`canvas_note:${newCanvasNote.nodeId}`].content_plain, '标题\n正文')
  const canvasNoteUpdateMetadata = { ...canvasNoteMetadata, undoContextId: 'canvas-note-update' }
  await assert.rejects(canvasNoteOps.update(other, newCanvasNote.nodeId, { version: 1, title: '越权' }, canvasNoteUpdateMetadata), { statusCode: 404 })
  await assert.rejects(canvasNoteOps.update(owner, newCanvasNote.nodeId, { version: 0, title: '旧版本' }, canvasNoteUpdateMetadata), { statusCode: 409 })
  assert.equal((await canvasNoteOps.update(owner, newCanvasNote.nodeId, { version: 0 }, canvasNoteUpdateMetadata)).version, 1)
  assert.equal((await db.selectFrom('undo_operations').selectAll().where('undo_context_id', '=', 'canvas-note-update').execute()).length, 0)
  assert.deepEqual(canvasNoteEvents, ['published', 'reported'])
  const changedCanvasNote = await canvasNoteOps.update(owner, newCanvasNote.nodeId, { version: 1, contentMd: '**变更**' }, canvasNoteUpdateMetadata)
  assert.equal(changedCanvasNote.version, 2)
  assert.equal((await db.selectFrom('mind_nodes').select('content_plain').where('id', '=', newCanvasNote.nodeId).executeTakeFirstOrThrow()).content_plain, '变更')
  assert.deepEqual(canvasNoteEvents, ['published', 'reported', 'published', 'reported'])
  const itemsBeforeUpdateRollback = await db.selectFrom('mind_canvas_items').selectAll().where('canvas_id', '=', relationCanvas.id).orderBy('id').execute()
  const unavailableFiles = createMindRefNodeCreator(createSqlMindRefNodeCreateRuntime(db, backend, async () => {}))
  await assert.rejects(unavailableFiles.create(owner, { refType: 'file', refId: 1 }, { undoContextId: null, clientId: null, mutationId: null }), /files/i)
  await sql.raw(tablesSql(backend).calendarEvents).execute(db)
  const fileIdType = backend === 'sqlite' ? 'INTEGER PRIMARY KEY' : 'SERIAL PRIMARY KEY'
  const fileOwnerType = backend === 'sqlite' ? 'TEXT' : 'UUID'
  await sql.raw(`CREATE TABLE files (id ${fileIdType}, user_id ${fileOwnerType} NOT NULL, display_name TEXT NOT NULL, ext TEXT NOT NULL, deleted_at TEXT)`).execute(db)
  await sql`INSERT INTO files (id,user_id,display_name,ext,deleted_at) VALUES (1,${storedOwner},'文件','md',NULL), (2,${storedOwner},'已删','txt',${stamp}), (3,${storedOwner},'回滚','txt',NULL)`.execute(db)
  await sql`INSERT INTO calendar_events (user_id,title,date,time,end_time,type,version,created_at,deleted_at) VALUES (${storedOwner},'活动','2026-11-14','09:30','10:15','event',1,${stamp},${stamp})`.execute(db)
  await db.updateTable('projects').set({ deleted_at: stamp }).where('id', '=', 1).execute()
  const refEvents: string[] = []
  const refs = createMindRefNodeCreator(createSqlMindRefNodeCreateRuntime(db, backend, async () => { refEvents.push('published'); throw new Error('notification') }, () => { refEvents.push('reported') }, () => '2026-11-14T22:00:00.000Z'))
  const refMetadata = { undoContextId: 'reference', clientId: null, mutationId: null }
  await assert.rejects(refs.create(other, { refType: 'project', refId: 1 }, refMetadata), { statusCode: 404 })
  await assert.rejects(refs.create(owner, { refType: 'file', refId: 2 }, refMetadata), { statusCode: 404 })
  const projectRef = await refs.create(owner, { refType: 'project', refId: 1 }, refMetadata)
  const eventRef = await refs.create(owner, { refType: 'event', refId: 1 }, refMetadata)
  const fileRef = await refs.create(owner, { refType: 'file', refId: 1 }, refMetadata)
  assert.equal(projectRef.title, '项目')
  assert.equal(typeof projectRef.id, 'number')
  assert.equal(projectRef.refSnapshot?.status, 'active')
  assert.deepEqual(eventRef.refSnapshot, { date: '2026-11-14', time: '09:30', endTime: '10:15' })
  assert.deepEqual(fileRef.refSnapshot, { ext: 'md' })
  assert.equal((await refs.create(owner, { refType: 'file', refId: 1 }, refMetadata)).id, fileRef.id)
  assert.deepEqual(refEvents, ['published', 'reported', 'published', 'reported', 'published', 'reported'])
  assert.equal((await db.selectFrom('undo_operations').selectAll().where('undo_context_id', '=', 'reference').execute()).length, 3)
  if (backend === 'postgres') {
    const concurrentRefs = await Promise.all(Array.from({ length: 3 }, () => refs.create(owner, { refType: 'file', refId: 3 }, { ...refMetadata, undoContextId: null })))
    assert.equal(new Set(concurrentRefs.map(row => row.id)).size, 1)
    await db.deleteFrom('mind_nodes').where('id', '=', concurrentRefs[0]!.id).execute()
  }
  await sql`UPDATE calendar_events SET deleted_at=NULL WHERE id=1`.execute(db)
  const eventCanvasItem = await addItem(owner, itemCanvas.id, { nodeId: eventRef.id, z: -10 }, { ...addMetadata, undoContextId: null })
  await sql`INSERT INTO mind_canvas_items (user_id, canvas_id, node_id, x, y, z, collapsed, data_json, created_at, updated_at, deleted_at) VALUES (${storedOwner}, ${itemCanvas.id}, ${note.id}, 0, 0, 0, ${bool}, '{}', ${stamp}, ${stamp}, ${stamp})`.execute(db)
  const readRelation = (await sql<{ id: number }>`INSERT INTO mind_relations (user_id, canvas_id, src_node_id, dst_node_id, rel_type, edge_key, origin, status, created_at, updated_at) VALUES (${storedOwner}, ${itemCanvas.id}, ${eventRef.id}, ${canvasNote.id}, 'related', 'read', 'user', 'confirmed', ${stamp}, ${stamp}) RETURNING id`.execute(db)).rows[0]!
  await db.updateTable('mind_maps').set({ data_json: JSON.stringify({ detachedRelationIds: [Number(readRelation.id)] }) }).where('id', '=', itemCanvas.id).execute()
  const reader = createSqlMindCanvasReader(db, backend)
  assert.equal((await reader.listCanvases(other, null)).length, 0)
  assert.equal((await reader.listCanvases(owner, 1)).some(row => row.id === canvas.id), true)
  assert.equal((await reader.listCanvases(owner, 999)).length, 0)
  assert.equal(await reader.listItems(other, itemCanvas.id), null)
  assert.equal(await reader.listRelations(other, itemCanvas.id), null)
  const readItems = await reader.listItems(owner, itemCanvas.id)
  assert.ok(readItems)
  assert.equal(readItems[0]!.id, eventCanvasItem.id)
  assert.deepEqual(readItems[0]!.refData, { date: '2026-11-14', time: '09:30', endTime: '10:15', description: null })
  assert.equal(readItems.some(row => row.nodeId === note.id), false)
  const readRelations = await reader.listRelations(owner, itemCanvas.id)
  assert.ok(readRelations)
  assert.equal(readRelations.some(row => row.id === Number(readRelation.id)), false)
  assert.equal(readRelations.some(row => row.id === Number(removalRelations.rows[0]!.id)), true)
  assert.equal(await reader.canvasLocation(owner, newCanvasNote.nodeId), relationCanvas.id)
  assert.equal(await reader.canvasLocation(other, newCanvasNote.nodeId), null)
  assert.equal(await reader.canvasLocation(owner, eventRef.id), null)
  const earlierWriter = createSqlMindNoteInserter(db, backend, () => '2026-11-14T10:00:00.000Z')
  const laterWriter = createSqlMindNoteInserter(db, backend, () => '2026-11-14T11:00:00.000Z')
  const firstSameDay = await earlierWriter(owner, prepareMindNoteCreate({ contentMd: '当日先写', capturedAt: '2026-11-12T23:00:00Z' }, new Date('2026-11-14T11:00:00Z')), null)
  const secondSameDay = await laterWriter(owner, prepareMindNoteCreate({ contentMd: '当日后写', capturedAt: '2026-11-12T01:00:00Z' }, new Date('2026-11-14T11:00:00Z')), null)
  const tieSameDay = await laterWriter(owner, prepareMindNoteCreate({ contentMd: '同秒后写', capturedAt: '2026-11-12T00:00:00Z' }, new Date('2026-11-14T11:00:00Z')), null)
  const readerNotes = createSqlMindNoteReader(db, backend)
  const allNotes = await readerNotes.list(owner, 200, 0)
  const dayIds = allNotes.filter(row => [firstSameDay.id, secondSameDay.id, tieSameDay.id].includes(row.id)).map(row => row.id)
  assert.deepEqual(dayIds, [tieSameDay.id, secondSameDay.id, firstSameDay.id])
  const start = allNotes.findIndex(row => row.id === tieSameDay.id)
  assert.deepEqual((await readerNotes.list(owner, 2, start)).map(row => row.id), [tieSameDay.id, secondSameDay.id])
  assert.equal((await readerNotes.get(owner, firstSameDay.id))?.contentMd, '当日先写')
  assert.equal(await readerNotes.get(other, firstSameDay.id), null)
  assert.equal(await readerNotes.get(owner, newCanvasNote.nodeId), null)
  assert.equal(await readerNotes.get(owner, note.id), null)
  assert.equal((await readerNotes.list(other, 200, 0)).some(row => row.id === firstSameDay.id), false)
  const undoSubject = await canvasNoteOps.create(owner, itemCanvas.id, { title: '撤销便签', contentMd: '原文' }, { undoContextId: 'adapter-test', clientId: null, mutationId: null })
  const undoRow = await db.selectFrom('undo_operations').selectAll().where('undo_context_id', '=', 'adapter-test').executeTakeFirstOrThrow()
  const json = (value: unknown) => typeof value === 'string' ? JSON.parse(value) : value
  const operation = { id: undoRow.id, action: undoRow.action, before_state: json(undoRow.before_state), after_state: json(undoRow.after_state) }
  await assert.rejects(db.transaction().execute(tx => applyMindUndoInTransaction(tx, backend, other, operation, 'undo')), MindUndoConflict)
  await db.updateTable('mind_nodes').set({ captured_at: backend === 'sqlite' ? '2026-11-14 21:00:00.000001' : '2026-11-14T21:00:00.000001Z' }).where('id', '=', undoSubject.nodeId).execute()
  await assert.rejects(db.transaction().execute(tx => applyMindUndoInTransaction(tx, backend, owner, operation, 'undo')), MindUndoConflict)
  await db.updateTable('mind_nodes').set({ captured_at: backend === 'sqlite' ? '2026-11-14 21:00:00.000000' : '2026-11-14T21:00:00.000000Z' }).where('id', '=', undoSubject.nodeId).execute()
  const undoNodeBefore = await db.selectFrom('mind_nodes').selectAll().where('id', '=', undoSubject.nodeId).executeTakeFirstOrThrow()
  const undoItemBefore = await db.selectFrom('mind_canvas_items').selectAll().where('id', '=', undoSubject.id).executeTakeFirstOrThrow()
  const invalidOperation = { ...operation, after_state: { ...operation.after_state, items: { ...operation.after_state.items, [`canvas_item:${undoSubject.id}`]: { ...operation.after_state.items[`canvas_item:${undoSubject.id}`], x: 999 } } } }
  await assert.rejects(db.transaction().execute(tx => applyMindUndoInTransaction(tx, backend, owner, invalidOperation, 'undo')), MindUndoConflict)
  assert.deepEqual(await db.selectFrom('mind_nodes').selectAll().where('id', '=', undoSubject.nodeId).executeTakeFirstOrThrow(), undoNodeBefore)
  assert.deepEqual(await db.selectFrom('mind_canvas_items').selectAll().where('id', '=', undoSubject.id).executeTakeFirstOrThrow(), undoItemBefore)
  const undoResult = await db.transaction().execute(tx => applyMindUndoInTransaction(tx, backend, owner, operation, 'undo', () => '2026-11-14T23:00:00.000Z'))
  assert.equal(undoResult.events[0]?.operation, 'delete')
  assert.equal(undoResult.versions[`canvas_note:${undoSubject.nodeId}`], 2)
  assert.ok((await db.selectFrom('mind_canvas_items').select('deleted_at').where('id', '=', undoSubject.id).executeTakeFirstOrThrow()).deleted_at)
  operation.after_state.undo_versions = undoResult.versions
  const redoResult = await db.transaction().execute(tx => applyMindUndoInTransaction(tx, backend, owner, operation, 'redo', () => '2026-11-14T23:01:00.000Z'))
  assert.equal(redoResult.events[0]?.operation, 'create')
  assert.equal(redoResult.versions[`canvas_note:${undoSubject.nodeId}`], 3)
  assert.equal((await db.selectFrom('mind_canvas_items').select('deleted_at').where('id', '=', undoSubject.id).executeTakeFirstOrThrow()).deleted_at, null)
  await assert.rejects(db.transaction().execute(tx => applyMindUndoInTransaction(tx, backend, owner, operation, 'redo')), MindUndoConflict)
  const replayOperation = { ...operation, after_state: { ...operation.after_state, items: { ...operation.after_state.items, [`canvas_note:${undoSubject.nodeId}`]: { ...operation.after_state.items[`canvas_note:${undoSubject.nodeId}`], version: 3 } } } }
  if (backend === 'sqlite') await sql.raw("CREATE TRIGGER fail_mind_undo BEFORE UPDATE ON mind_canvas_items BEGIN SELECT RAISE(ABORT, 'test undo failure'); END").execute(db)
  else {
    await sql.raw("CREATE FUNCTION fail_mind_undo() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test undo failure'; END $$").execute(db)
    await sql.raw('CREATE TRIGGER fail_mind_undo BEFORE UPDATE ON mind_canvas_items FOR EACH ROW EXECUTE FUNCTION fail_mind_undo()').execute(db)
  }
  await db.transaction().execute(async tx => {
    await assert.rejects(applyMindUndoInTransaction(tx, backend, owner, replayOperation, 'undo'))
  })
  const rollbackNode = await db.selectFrom('mind_nodes').selectAll().where('id', '=', undoSubject.nodeId).executeTakeFirstOrThrow()
  assert.equal(rollbackNode.version, 3)
  assert.equal(rollbackNode.deleted_at, null)
  if (backend === 'sqlite') await sql.raw('DROP TRIGGER fail_mind_undo').execute(db)
  else { await sql.raw('DROP TRIGGER fail_mind_undo ON mind_canvas_items').execute(db); await sql.raw('DROP FUNCTION fail_mind_undo()').execute(db) }
  const refUndoRow = (await db.selectFrom('undo_operations').selectAll().where('undo_context_id', '=', 'reference').execute()).find(row => {
    const refs = json(row.target_refs) as Array<{ id: number }>
    return refs.some(ref => ref.id === fileRef.id)
  })!
  const refOperation = { id: refUndoRow.id, action: refUndoRow.action, before_state: json(refUndoRow.before_state), after_state: json(refUndoRow.after_state) }
  const refUndo = await db.transaction().execute(tx => applyMindUndoInTransaction(tx, backend, owner, refOperation, 'undo', () => '2026-11-14T23:10:00Z'))
  refOperation.after_state.undo_versions = refUndo.versions
  await db.transaction().execute(tx => applyMindUndoInTransaction(tx, backend, owner, refOperation, 'redo', () => '2026-11-14T23:11:00Z'))
  const restoredRef = await db.selectFrom('mind_nodes').select('ref_snapshot').where('id', '=', fileRef.id).executeTakeFirstOrThrow()
  assert.deepEqual(json(restoredRef.ref_snapshot), { ext: 'md' })
  const nodesBeforeRefRollback = (await db.selectFrom('mind_nodes').selectAll().execute()).length
  await sql`DROP TABLE undo_operations`.execute(db)
  await assert.rejects(refs.create(owner, { refType: 'file', refId: 3 }, refMetadata))
  assert.equal((await db.selectFrom('mind_nodes').selectAll().execute()).length, nodesBeforeRefRollback)
  await assert.rejects(canvasNoteOps.create(owner, relationCanvas.id, {}, canvasNoteMetadata))
  await assert.rejects(canvasNoteOps.update(owner, newCanvasNote.nodeId, { version: 2, title: '回滚' }, canvasNoteUpdateMetadata))
  assert.equal((await db.selectFrom('mind_nodes').select('version').where('id', '=', newCanvasNote.nodeId).executeTakeFirstOrThrow()).version, 2)
  await assert.rejects(itemUpdate.update(owner, relationCanvas.id, Number(firstItem.id), { x: 999 }, itemUpdateMetadata))
  await assert.rejects(itemUpdate.bringToFront(owner, relationCanvas.id, Number(firstItem.id), { x: 999, y: 999 }, itemUpdateMetadata))
  assert.deepEqual(await db.selectFrom('mind_canvas_items').selectAll().where('canvas_id', '=', relationCanvas.id).orderBy('id').execute(), itemsBeforeUpdateRollback)
  await assert.rejects(addItem(owner, itemCanvas.id, { nodeId: Number(second.id) }, addMetadata))
  assert.equal((await db.selectFrom('mind_canvas_items').selectAll().where('canvas_id', '=', itemCanvas.id).where('node_id', '=', Number(second.id)).execute()).length, 0)
  await assert.rejects(deleteRelation(owner, relationCanvas.id, rollbackRelation.id, relationDeleteMetadata))
  assert.equal((await db.selectFrom('mind_relations').select('deleted_at').where('id', '=', rollbackRelation.id).executeTakeFirstOrThrow()).deleted_at, null)
  await assert.rejects(createRelation(owner, { ...relationInput, allowParallel: true }, relationMetadata))
  assert.equal((await db.selectFrom('mind_relations').selectAll().where('canvas_id', '=', relationCanvas.id).execute()).length, 3)
  await assert.rejects(removeItem(owner, canvas.id, 3, removeMetadata))
  assert.deepEqual(await db.selectFrom('mind_maps').selectAll().where('id', '=', canvas.id).executeTakeFirstOrThrow(), canvasDataBeforeRemoveRollback)
  assert.deepEqual((await sql`SELECT * FROM mind_canvas_items WHERE canvas_id = ${canvas.id} ORDER BY id`.execute(db)).rows, itemsBeforeRollback)
  await assert.rejects(deleteGlobal(owner, Number(rollbackGlobal.id), globalMetadata))
  assert.equal((await db.selectFrom('mind_relations').select('deleted_at').where('id', '=', Number(rollbackGlobal.id)).executeTakeFirstOrThrow()).deleted_at, null)
  await assert.rejects(deleteCanvas(owner, canvas.id, { undoContextId: 'delete-canvas', clientId: null }))
  assert.equal((await db.selectFrom('mind_maps').select('deleted_at').where('id', '=', canvas.id).executeTakeFirstOrThrow()).deleted_at, null)
  assert.deepEqual((await sql`SELECT * FROM mind_canvas_items WHERE canvas_id = ${canvas.id} ORDER BY id`.execute(db)).rows, itemsBeforeRollback)
  assert.deepEqual((await sql`SELECT * FROM mind_relations WHERE canvas_id = ${canvas.id} ORDER BY id`.execute(db)).rows, relationsBeforeRollback)
  assert.deepEqual(await db.selectFrom('mind_nodes').selectAll().where('id', '=', canvasNote.id).executeTakeFirstOrThrow(), noteBeforeRollback)
  await assert.rejects(updateCanvas(owner, canvas.id, { title: '回滚' }, { undoContextId: 'canvas-update', clientId: null }))
  assert.equal((await db.selectFrom('mind_maps').select('title').where('id', '=', canvas.id).executeTakeFirstOrThrow()).title, '新标题')
  await assert.rejects(createCanvas(owner, {}, { undoContextId: 'canvas', clientId: null }))
  assert.equal((await sql<{ count: number }>`SELECT count(*) AS count FROM mind_maps`.execute(db)).rows[0]!.count, backend === 'postgres' ? '4' : 4)
  await assert.rejects(mutator.update(owner, Number(second.id), { version: 1, title: '回滚' }, 'tab'))
  await assert.rejects(mutator.delete(owner, Number(second.id), 'tab'))
  const unchanged = await db.selectFrom('mind_nodes').selectAll().where('id', '=', second.id).executeTakeFirstOrThrow()
  assert.equal(unchanged.title, second.title)
  assert.equal(unchanged.version, 1)
  assert.equal(unchanged.deleted_at, null)
  await assert.rejects(insert(owner, input, 'tab'))
  assert.equal((await db.selectFrom('mind_nodes').selectAll().execute()).length, nodesBeforeRefRollback)

  // 抽屉往返后，旧相机和锚点快照都不能恢复已断开的线。
  const noUndo = { undoContextId: null, clientId: null, mutationId: null }
  const projectItem = await addItem(owner, relationCanvas.id, { nodeId: projectRef.id }, noUndo)
  const projectLink = { canvasId: relationCanvas.id, srcNodeId: canvasNote.id, dstNodeId: projectRef.id }
  const oldLink = await createRelation(owner, projectLink, noUndo)
  const oldParallel = await createRelation(owner, { ...projectLink, allowParallel: true }, noUndo)
  const oldView = { scale: 1, relationAnchors: { [oldLink.id]: { srcSide: 'right', dstSide: 'left' } } }
  await updateCanvas(owner, relationCanvas.id, { data: oldView }, noUndo)
  const readLinkIds = async () => (await reader.listRelations(owner, relationCanvas.id))!.map(row => row.id)
  const unrelated = (await readLinkIds()).filter(id => id !== oldLink.id && id !== oldParallel.id)
  await removeItem(owner, relationCanvas.id, projectItem.id, noUndo)
  await updateCanvas(owner, relationCanvas.id, { data: { ...oldView, scale: 1.25, detachedRelationIds: [] } }, noUndo)
  await addItem(owner, relationCanvas.id, { nodeId: projectRef.id }, noUndo)
  assert.deepEqual(await readLinkIds(), unrelated)
  const reconnected = await createRelation(owner, projectLink, noUndo)
  await updateCanvas(owner, relationCanvas.id, { data: { ...oldView, detachedRelationIds: [oldLink.id, oldParallel.id] } }, noUndo)
  assert.deepEqual(await readLinkIds(), [...unrelated, reconnected.id].sort((a, b) => a - b))
}
