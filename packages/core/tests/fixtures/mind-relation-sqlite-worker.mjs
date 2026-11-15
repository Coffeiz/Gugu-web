import { openSqliteRuntime } from '../../dist/data/index.js'
import { createMindCanvasRelationCreate, createSqlMindCanvasRelationCreateRuntime } from '../../dist/mind/index.js'

const { runtime, ownerId } = await openSqliteRuntime(process.argv[2])
const create = createMindCanvasRelationCreate(createSqlMindCanvasRelationCreateRuntime(runtime.db, 'sqlite', async () => {}))
process.on('message', async message => {
  if (message === 'close') { await runtime.close(); process.disconnect(); return }
  try {
    const started = Date.now()
    const metadata = { undoContextId: 'concurrent-delete', clientId: null, mutationId: null }
    const result = message === 'note-update'
      ? await (async () => { const { createMindCanvasNoteMutations, createSqlMindCanvasNoteRuntime } = await import('../../dist/mind/index.js'); return createMindCanvasNoteMutations(createSqlMindCanvasNoteRuntime(runtime.db, 'sqlite', async () => {})).update(ownerId, 3, { version: 1, title: '并发更新' }, { ...metadata, undoContextId: 'concurrent-canvas-note' }) })()
      : message === 'update' || message === 'front'
      ? await (async () => { const { createMindCanvasItemUpdate, createSqlMindCanvasItemUpdateRuntime } = await import('../../dist/mind/index.js'); const operations = createMindCanvasItemUpdate(createSqlMindCanvasItemUpdateRuntime(runtime.db, 'sqlite', async () => {})); return message === 'update' ? operations.update(ownerId, 1, 1, { x: 55 }, { ...metadata, undoContextId: 'concurrent-update' }) : operations.bringToFront(ownerId, 1, 2, { x: 66, y: 77 }, { ...metadata, undoContextId: 'concurrent-front' }) })()
      : message === 'add'
      ? await (async () => { const { createMindCanvasItemAdd, createSqlMindCanvasItemAddRuntime } = await import('../../dist/mind/index.js'); return createMindCanvasItemAdd(createSqlMindCanvasItemAddRuntime(runtime.db, 'sqlite', async () => {}))(ownerId, 1, { nodeId: 3 }, { ...metadata, undoContextId: 'concurrent-add' }) })()
      : message === 'delete'
      ? await (async () => { const { createMindCanvasRelationDelete, createSqlMindCanvasRelationDeleteRuntime } = await import('../../dist/mind/index.js'); return createMindCanvasRelationDelete(createSqlMindCanvasRelationDeleteRuntime(runtime.db, 'sqlite', async () => {}))(ownerId, 1, 1, metadata) })()
      : await create(ownerId, { canvasId: 1, srcNodeId: 1, dstNodeId: 2 }, { undoContextId: null, clientId: null, mutationId: null })
    process.send?.({ id: result.id, elapsed: Date.now() - started })
  } catch (error) { process.send?.({ error: error instanceof Error ? error.message : String(error), status: error?.statusCode ?? null }) }
})
process.send?.({ ready: true })
