import type { SqlDataRuntime } from '@gugu/core/data'
import {
  createCanvasBatchPort,
  createCanvasEditPort,
  createCanvasDeleteNotePort,
  createCanvasDeletePort,
  createCanvasDisconnectPort,
  createNoteLifecyclePort,
} from '@gugu/core/tools'
import type { CanvasBatchConfirmationPort } from '@gugu/core/tools'

/** 使用 Core 画布事务实现；破坏性工具只带入可信 Host 确认端口时才会注册。 */
export function createWebAgentCanvasWritePorts(options: {
  core: SqlDataRuntime
  publishBatchAndNotes: Parameters<typeof createCanvasBatchPort>[1]
  publishDisconnect: Parameters<typeof createCanvasDisconnectPort>[1]
  publishDelete: Parameters<typeof createCanvasDeletePort>[1]
  batchConfirmation?: CanvasBatchConfirmationPort
  deleteNoteConfirmation?: CanvasBatchConfirmationPort
  disconnectConfirmation?: CanvasBatchConfirmationPort
  deleteConfirmation?: CanvasBatchConfirmationPort
}) {
  return {
    canvasBatch: createCanvasBatchPort(options.core, options.publishBatchAndNotes, options.batchConfirmation),
    canvasDeleteNote: createCanvasDeleteNotePort(options.core, options.publishBatchAndNotes, options.deleteNoteConfirmation),
    canvasDisconnect: createCanvasDisconnectPort(options.core, options.publishDisconnect, options.disconnectConfirmation),
    canvasDelete: createCanvasDeletePort(options.core, options.publishDelete, options.deleteConfirmation),
  }
}

/** 非破坏性 Mind 写工具复用同一 Core 事务、收据和发布通道。 */
export function createWebAgentCanvasMutationPorts(options: {
  core: SqlDataRuntime
  publish: Parameters<typeof createCanvasEditPort>[1]
  publishNote: Parameters<typeof createNoteLifecyclePort>[1]
}) {
  const canvasEdits = createCanvasEditPort(options.core, options.publish)
  return {
    canvasEdits,
    canvasPlacements: canvasEdits,
    canvasRelations: canvasEdits,
    noteLifecycle: createNoteLifecyclePort(options.core, options.publishNote),
  }
}
