import { type SqlDataRuntime } from '@gugu/core/data'
import { createMindCanvasNoteMutations } from '@gugu/core/mind'
import { createMindRefNodeCreator } from '@gugu/core/mind'
import { createMindNoteCreator } from '@gugu/core/mind'
import { createMindCanvasCreation, createMindCanvasUpdate, createMindCanvasDelete, createMindCanvasItemAdd, createMindCanvasItemRemove, createMindCanvasItemUpdate, createMindCanvasRelationCreate, createMindCanvasRelationDelete, createMindGlobalRelationDelete, createSqlMindCanvasCreateRuntime, createSqlMindCanvasUpdateRuntime, createSqlMindCanvasDeleteRuntime, createSqlMindCanvasNoteRuntime, createSqlMindCanvasItemAddRuntime, createSqlMindCanvasItemRemoveRuntime, createSqlMindCanvasItemUpdateRuntime, createSqlMindCanvasRelationCreateRuntime, createSqlMindCanvasRelationDeleteRuntime, createSqlMindGlobalRelationDeleteRuntime, createSqlMindRefNodeCreateRuntime, createSqlMindNoteInserter, createSqlMindNoteMutator } from '@gugu/core/mind'
import { createMindNoteMutations } from '@gugu/core/mind'
import { type RedisEventPublisher } from '../adapters/cache/redis-events.js'

export function createMindServices(core: SqlDataRuntime, publisher: RedisEventPublisher) {
  const createMindNote = createMindNoteCreator({
    insert: createSqlMindNoteInserter(core.db, 'postgres'),
    async publishCreated({ ownerId, note, clientId, mutationId }) {
      await publisher.publishResourceChanged({
        ownerId,
        resource: 'mind',
        operation: 'create',
        entityId: note.id,
        origin: clientId,
        mutationId,
        payload: { kind: 'note', entity: note },
      })
    },
    reportFailure(operation) {
      console.error(`gugu-webui ${operation} failed`)
    },
  })
  const mindNoteMutations = createMindNoteMutations({
    ...createSqlMindNoteMutator(core.db, 'postgres'),
    async publishUpdated({ ownerId, note, clientId, mutationId }) {
      await publisher.publishResourceChanged({
        ownerId,
        resource: 'mind',
        operation: 'update',
        entityId: note.id,
        origin: clientId,
        mutationId,
        payload: { kind: 'note', entity: note },
      })
    },
    async publishDeleted({ ownerId, noteId, clientId, mutationId }) {
      await publisher.publishResourceChanged({
        ownerId,
        resource: 'mind',
        operation: 'delete',
        entityId: noteId,
        origin: clientId,
        mutationId,
        payload: { kind: 'note', entity: { id: noteId } },
      })
    },
    reportFailure(operation) {
      console.error(`gugu-webui ${operation} failed`)
    },
  })
  const publishCanvasChanged = async ({ ownerId, operation, entityId, origin, entity }: { ownerId: string; operation: 'create' | 'update' | 'delete'; entityId: number; origin: string | null; entity: unknown }) => {
      await publisher.publishResourceChanged({
        ownerId,
        resource: 'mind',
        operation,
        entityId,
        origin,
        payload: { kind: 'canvas', entity },
      })
    }
  const reportMindFailure = (operation: string) => { console.error(`gugu-webui ${operation} 失败`) }
  const mindCanvasCreate = createMindCanvasCreation(createSqlMindCanvasCreateRuntime(core.db, 'postgres', publishCanvasChanged, reportMindFailure))
  const mindCanvasUpdate = createMindCanvasUpdate(createSqlMindCanvasUpdateRuntime(core.db, 'postgres', publishCanvasChanged, reportMindFailure))
  const mindCanvasDelete = createMindCanvasDelete(createSqlMindCanvasDeleteRuntime(core.db, 'postgres', publishCanvasChanged, reportMindFailure))
  const mindCanvasNoteMutations = createMindCanvasNoteMutations(createSqlMindCanvasNoteRuntime(
    core.db, 'postgres',
    async ({ ownerId, operation, entityId, origin, mutationId, entityKind, entity }) => {
      await publisher.publishResourceChanged({
        ownerId,
        resource: 'mind',
        operation,
        entityId,
        origin,
        mutationId,
        payload: { kind: entityKind, entity },
      })
    },
    (operation) => {
      console.error(`gugu-webui ${operation} failed`)
    },
  ))
  const mindCanvasItemUpdate = createMindCanvasItemUpdate(createSqlMindCanvasItemUpdateRuntime(
    core.db, 'postgres', async ({ ownerId, operation, entityId, origin, mutationId, entity }) => {
      await publisher.publishResourceChanged({ ownerId, resource: 'mind', operation, entityId, origin, mutationId, payload: { kind: 'canvas_item', entity } })
    }, reportMindFailure,
  ))
  const mindCanvasItemRemove = createMindCanvasItemRemove(createSqlMindCanvasItemRemoveRuntime(
    core.db, 'postgres', async ({ ownerId, operation, entityId, origin, mutationId, entity }) => {
      await publisher.publishResourceChanged({ ownerId, resource: 'mind', operation, entityId, origin, mutationId, payload: { kind: 'canvas_item', entity } })
    }, reportMindFailure,
  ))
  const mindCanvasItemAdd = createMindCanvasItemAdd(createSqlMindCanvasItemAddRuntime(
    core.db, 'postgres', async ({ ownerId, operation, entityId, origin, mutationId, entity }) => {
      await publisher.publishResourceChanged({ ownerId, resource: 'mind', operation, entityId, origin, mutationId, payload: { kind: 'canvas_item', entity } })
    }, reportMindFailure,
  ))
  const mindGlobalRelationDelete = createMindGlobalRelationDelete(createSqlMindGlobalRelationDeleteRuntime(
    core.db, 'postgres', async ({ ownerId, operation, entityId, origin, mutationId, entity }) => {
      await publisher.publishResourceChanged({ ownerId, resource: 'mind', operation, entityId, origin, mutationId, payload: { kind: 'relation', entity } })
    }, reportMindFailure,
  ))
  const mindCanvasRelationCreate = createMindCanvasRelationCreate(createSqlMindCanvasRelationCreateRuntime(
    core.db, 'postgres', async ({ ownerId, operation, entityId, origin, mutationId, entity }) => {
      await publisher.publishResourceChanged({ ownerId, resource: 'mind', operation, entityId, origin, mutationId, payload: { kind: 'relation', entity } })
    }, reportMindFailure,
  ))
  const mindCanvasRelationDelete = createMindCanvasRelationDelete(createSqlMindCanvasRelationDeleteRuntime(
    core.db, 'postgres', async ({ ownerId, operation, entityId, origin, mutationId, entity }) => {
      await publisher.publishResourceChanged({ ownerId, resource: 'mind', operation, entityId, origin, mutationId, payload: { kind: 'relation', entity } })
    }, reportMindFailure,
  ))
  const mindRefNodeCreator = createMindRefNodeCreator(createSqlMindRefNodeCreateRuntime(
    core.db, 'postgres',
    async ({ ownerId, entityId, origin, mutationId, entity }) => {
      await publisher.publishResourceChanged({
        ownerId,
        resource: 'mind',
        operation: 'create',
        entityId,
        origin,
        mutationId,
        payload: { kind: 'ref_node', entity },
      })
    },
    (operation) => {
      console.error(`gugu-webui ${operation} failed`)
    },
  ))
  return { createMindNote, mindNoteMutations, mindCanvasCreate, mindCanvasUpdate, mindCanvasDelete, mindCanvasNoteMutations, mindCanvasItemUpdate, mindCanvasItemRemove, mindCanvasItemAdd, mindGlobalRelationDelete, mindCanvasRelationCreate, mindCanvasRelationDelete, mindRefNodeCreator, publishCanvasChanged }
}
