import { parentPort, workerData } from 'node:worker_threads'
import { dataContext, CoreError } from '../contracts/index.js'
import type { Fields } from '../contracts/index.js'
import { initializeSqlite, openSqliteRuntime } from '../data/sqlite.js'
import { execute, isMutation, validateCommandParams } from './commands.js'
import { applyUndoInTransaction, createRuntimeUndoTransactionPort, createUndoStateMachine, UndoError } from '../undo/state-machine.js'
import { createCalendarEvent, EventCreateError } from '../calendar/application/event-create.js'
import { createCalendarEventReader } from '../calendar/application/event-read.js'
import { createBorrowedCalendarCreateStore } from '../calendar/create-store.js'
import { createKyselyCalendarReadPort } from '../calendar/read-store.js'
import { createBorrowedKyselyCalendarMutationStores } from '../calendar/mutation-store.js'
import { updateCalendarEvent, EventUpdateError } from '../calendar/application/event-update.js'
import { deleteCalendarEvent, EventDeleteError } from '../calendar/application/event-delete.js'
import { createCalendarUndoAdapter } from '../calendar/undo-adapter.js'
import { createMindNoteCreator, MindNoteCreateError } from '../mind/note-create.js'
import { createSqlMindNoteReader } from '../mind/note-read.js'
import { createBorrowedSqlMindNoteInserter } from '../mind/note-postgres-sqlite.js'
import { createMindNoteMutations, MindNoteMutationError } from '../mind/note-mutations.js'
import { createSqlMindNoteMutator } from '../mind/note-mutations-sql.js'
import { createSqlMindCanvasReader } from '../mind/canvas-read.js'
import { createMindCanvasCreation, MindCanvasMutationError } from '../mind/canvas-create.js'
import { createSqlMindCanvasCreateRuntime } from '../mind/canvas-create-sql.js'
import { createMindCanvasUpdate } from '../mind/canvas-update.js'
import { createSqlMindCanvasUpdateRuntime } from '../mind/canvas-update-sql.js'
import { createMindCanvasDelete } from '../mind/canvas-delete.js'
import { createSqlMindCanvasDeleteRuntime } from '../mind/canvas-delete-sql.js'
import { createMindCanvasNoteMutations, MindCanvasNoteMutationError } from '../mind/canvas-note.js'
import { createSqlMindCanvasNoteRuntime } from '../mind/canvas-note-sql.js'
import { createMindCanvasItemUpdate } from '../mind/canvas-item-update.js'
import { createSqlMindCanvasItemUpdateRuntime } from '../mind/canvas-item-update-sql.js'
import { createMindCanvasItemRemove, MindCanvasItemMutationError } from '../mind/canvas-item-remove.js'
import { createSqlMindCanvasItemRemoveRuntime } from '../mind/canvas-item-remove-sql.js'

interface Job {
  id: number
  method: string
  params: Fields
  operationId?: string
  cancel: SharedArrayBuffer
  deadline: number
}
const port = parentPort!
try {
  const config = workerData as {
    database: string
    initialize: boolean
    allowLegacySchema: boolean
    exclusive: boolean
  }
  if (config.initialize) await initializeSqlite(config.database)
  const { runtime, ownerId, schemaVersion } = await openSqliteRuntime(config.database, {
    allowLegacySchema: config.allowLegacySchema,
    exclusive: config.exclusive,
  })
  const context = dataContext(ownerId)
  port.postMessage({ event: 'ready', ownerId, schemaVersion })
  let queue = Promise.resolve()
  port.on('message', (job: Job) => {
    queue = queue.then(async () => {
      try {
        if (job.method === 'runtime.close') {
          await runtime.close()
          port.postMessage({ id: job.id, result: null })
          port.close()
          return
        }
        const flag = new Int32Array(job.cancel)
        const signal = {
          get aborted(): boolean {
            return Atomics.load(flag, 0) !== 0 || Date.now() >= job.deadline
          },
        }
        if (signal.aborted) throw new CoreError('cancelled', '操作已取消')
        let result: unknown
        if (job.method === 'operations.get') {
          validateCommandParams(job.method, job.params)
          const operationId = job.params.operation_id
          if (typeof operationId !== 'string')
            throw new CoreError('invalid_request', '操作标识必须是文本')
          result = await runtime.receipt(context, operationId)
        } else if (job.method === 'undo.preview') {
          validateCommandParams(job.method, job.params)
          result = await createUndoStateMachine(createRuntimeUndoTransactionPort(runtime), async () => {}).preview(ownerId, job.params.context_id as string)
        } else if (job.method === 'undo.apply' || job.method === 'undo.redo') {
          validateCommandParams(job.method, job.params)
          if (!job.operationId) throw new CoreError('invalid_request', '撤销写入必须提供稳定操作标识')
          const { result: outcome, replayed } = await runtime.operationWithTransaction(context, job.operationId, job.method, job.params,
            tx => applyUndoInTransaction(tx, runtime.backend, ownerId, job.params.context_id as string, job.params.undo_id as string, job.method === 'undo.apply' ? 'undo' : 'redo', { adapters: { calendar: createCalendarUndoAdapter(runtime.backend) } }), { signal })
          if (outcome.error) throw new UndoError(outcome.error.code, outcome.error.message, outcome.error.statusCode)
          result = replayed ? { ...outcome.result!, events: [] } : outcome.result
        } else if (job.method === 'calendar.list') {
          validateCommandParams(job.method, job.params)
          result = await createCalendarEventReader(createKyselyCalendarReadPort(runtime.db, runtime.backend)).list(ownerId)
        } else if (job.method === 'calendar.create') {
          validateCommandParams(job.method, job.params)
          if (!job.operationId) throw new CoreError('invalid_request', '日历写入必须提供稳定操作标识')
          const outcome = await runtime.operationWithTransaction(context, job.operationId, job.method, job.params,
            tx => createCalendarEvent(createBorrowedCalendarCreateStore(tx, runtime.backend), { ownerId, input: job.params, undoContextId: 'desktop-calendar' }), { signal })
          result = outcome.result.event
        } else if (job.method === 'calendar.update' || job.method === 'calendar.delete') {
          validateCommandParams(job.method, job.params)
          if (!job.operationId) throw new CoreError('invalid_request', '日历写入必须提供稳定操作标识')
          const outcome = await runtime.operationWithTransaction(context, job.operationId, job.method, job.params, tx => {
            const stores = createBorrowedKyselyCalendarMutationStores(tx, runtime.backend)
            return job.method === 'calendar.update'
              ? updateCalendarEvent(stores.update, { ownerId, eventId: Number(job.params.id), body: job.params.body, undoContextId: 'desktop-calendar' })
              : deleteCalendarEvent(stores.delete, { ownerId, eventId: Number(job.params.id), version: Number(job.params.version), undoContextId: 'desktop-calendar' }).then(() => null)
          }, { signal })
          result = outcome.result
        } else if (job.method === 'mind.notes.list') {
          validateCommandParams(job.method, job.params)
          result = await createSqlMindNoteReader(runtime.db, runtime.backend).list(ownerId, 200, 0)
        } else if (job.method === 'mind.notes.create') {
          validateCommandParams(job.method, job.params)
          if (!job.operationId) throw new CoreError('invalid_request', '便签写入必须提供稳定操作标识')
          const outcome = await runtime.operationWithTransaction(context, job.operationId, job.method, job.params, tx =>
            createMindNoteCreator({
              insert: createBorrowedSqlMindNoteInserter(tx, runtime.backend),
              async publishCreated() {},
            })(ownerId, job.params, { undoContextId: 'desktop-mind', clientId: null }), { signal })
          result = outcome.result
        } else if (job.method === 'mind.notes.update' || job.method === 'mind.notes.delete') {
          validateCommandParams(job.method, job.params)
          if (!job.operationId) throw new CoreError('invalid_request', '便签写入必须提供稳定操作标识')
          const outcome = await runtime.operationWithTransaction(context, job.operationId, job.method, job.params, tx => {
            const mutations = createMindNoteMutations({
              ...createSqlMindNoteMutator(tx, runtime.backend),
              async publishUpdated() {}, async publishDeleted() {},
            })
            return job.method === 'mind.notes.update'
              ? mutations.update(ownerId, Number(job.params.id), job.params.fields, { undoContextId: 'desktop-mind', clientId: null })
              : mutations.delete(ownerId, Number(job.params.id), { undoContextId: 'desktop-mind', clientId: null }).then(() => null)
          }, { signal })
          result = outcome.result
        } else if (job.method === 'mind.canvases.list') {
          validateCommandParams(job.method, job.params)
          result = await createSqlMindCanvasReader(runtime.db, runtime.backend).listCanvases(ownerId, null)
        } else if (job.method === 'mind.canvases.items.list') {
          validateCommandParams(job.method, job.params)
          result = await createSqlMindCanvasReader(runtime.db, runtime.backend).listItems(ownerId, Number(job.params.canvasId)) ?? []
        } else if (job.method === 'mind.canvases.notes.create' || job.method === 'mind.canvases.notes.update' || job.method === 'mind.canvases.items.update' || job.method === 'mind.canvases.items.delete') {
          validateCommandParams(job.method, job.params)
          if (!job.operationId) throw new CoreError('invalid_request', '画布内容写入必须提供稳定操作标识')
          const outcome = await runtime.operationWithTransaction<unknown>(context, job.operationId, job.method, job.params, tx => {
            if (job.method === 'mind.canvases.notes.create')
              return createMindCanvasNoteMutations(createSqlMindCanvasNoteRuntime(tx, runtime.backend, async () => {})).create(ownerId, Number(job.params.canvasId), job.params.body, { undoContextId: 'desktop-mind', clientId: null })
            if (job.method === 'mind.canvases.notes.update')
              return createMindCanvasNoteMutations(createSqlMindCanvasNoteRuntime(tx, runtime.backend, async () => {})).update(ownerId, Number(job.params.id), job.params.fields, { undoContextId: 'desktop-mind', clientId: null })
            if (job.method === 'mind.canvases.items.update')
              return createMindCanvasItemUpdate(createSqlMindCanvasItemUpdateRuntime(tx, runtime.backend, async () => {})).update(ownerId, Number(job.params.canvasId), Number(job.params.id), job.params.body, { undoContextId: 'desktop-mind', clientId: null, mutationId: null })
            return createMindCanvasItemRemove(createSqlMindCanvasItemRemoveRuntime(tx, runtime.backend, async () => {}))(ownerId, Number(job.params.canvasId), Number(job.params.id), { undoContextId: 'desktop-mind', clientId: null, mutationId: null }).then(() => null)
          }, { signal })
          result = outcome.result
        } else if (job.method === 'mind.canvases.create' || job.method === 'mind.canvases.update' || job.method === 'mind.canvases.delete') {
          validateCommandParams(job.method, job.params)
          if (!job.operationId) throw new CoreError('invalid_request', '画布写入必须提供稳定操作标识')
          const outcome = await runtime.operationWithTransaction(context, job.operationId, job.method, job.params, tx => {
            const publish = async () => {}
            if (job.method === 'mind.canvases.create')
              return createMindCanvasCreation(createSqlMindCanvasCreateRuntime(tx, runtime.backend, publish))(ownerId, job.params, { undoContextId: 'desktop-mind', clientId: null })
            if (job.method === 'mind.canvases.update')
              return createMindCanvasUpdate(createSqlMindCanvasUpdateRuntime(tx, runtime.backend, publish))(ownerId, Number(job.params.id), job.params.body, { undoContextId: 'desktop-mind', clientId: null })
            return createMindCanvasDelete(createSqlMindCanvasDeleteRuntime(tx, runtime.backend, publish))(ownerId, Number(job.params.id), { undoContextId: 'desktop-mind', clientId: null }).then(() => null)
          }, { signal })
          result = outcome.result
        } else if (job.operationId && isMutation(job.method))
          result = await runtime.operation(
            context,
            job.operationId,
            job.method,
            job.params,
            (data) => execute(data, job.method, job.params),
            { signal },
          )
        else
          result = await runtime.transaction(
            context,
            (data) => execute(data, job.method, job.params),
            { signal },
          )
        port.postMessage({ id: job.id, result })
      } catch (error) {
        const safe = error instanceof MindNoteMutationError
          ? new CoreError(error.statusCode === 409 ? 'conflict' : error.statusCode === 404 ? 'not_found' : 'invalid_request', error.message)
          : error instanceof MindNoteCreateError
          ? new CoreError('invalid_request', error.message)
          : error instanceof MindCanvasMutationError
          ? new CoreError(error.statusCode === 404 ? 'not_found' : 'invalid_request', error.message)
          : error instanceof MindCanvasNoteMutationError
          ? new CoreError(error.statusCode === 404 ? 'not_found' : error.statusCode === 409 ? 'conflict' : 'invalid_request', error.message)
          : error instanceof MindCanvasItemMutationError
          ? new CoreError(error.statusCode === 404 ? 'not_found' : 'invalid_request', error.message)
          : error instanceof EventCreateError
          ? new CoreError(error.statusCode === 409 ? 'conflict' : 'invalid_request', error.message)
          : error instanceof EventUpdateError
          ? new CoreError(error.statusCode === 409 ? 'conflict' : error.statusCode === 404 ? 'not_found' : 'invalid_request', error.message)
          : error instanceof EventDeleteError
          ? new CoreError(error.statusCode === 409 ? 'conflict' : 'not_found', error.message)
          : error instanceof UndoError
          ? new CoreError(error.code === 'undo.not_found' ? 'not_found' : error.code === 'undo.unsupported' ? 'invalid_request' : 'conflict', error.message)
          : error
        port.postMessage({
          id: job.id,
          error:
            safe instanceof CoreError
              ? { code: safe.code, message: safe.message }
              : { code: 'storage_error', message: '本地数据操作失败' },
        })
      }
    })
  })
} catch (error) {
  port.postMessage({
    event: 'failed',
    error:
      error instanceof CoreError
        ? { code: error.code, message: error.message }
        : {
            code: 'storage_error',
            message: '本地数据无法打开，请检查版本与文件权限',
          },
  })
  port.close()
}
