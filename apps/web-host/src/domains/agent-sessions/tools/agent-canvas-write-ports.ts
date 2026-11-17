import type { SqlDataRuntime } from '@gugu/core/data'
import {
  createCanvasBatchPort,
  createCanvasDeleteNotePort,
  createCanvasDeletePort,
  createCanvasDisconnectPort,
} from '@gugu/core/tools'
import type { CanvasBatchConfirmationPort } from '@gugu/core/tools'

/** 使用 Core 画布事务实现；破坏性工具只带入可信 Host 确认端口时才会注册。 */
export function createWebAgentCanvasWritePorts(options: {
  core: SqlDataRuntime
  publishBatchAndNotes: Parameters<typeof createCanvasBatchPort>[1]
  publishDisconnect: Parameters<typeof createCanvasDisconnectPort>[1]
  publishDelete: Parameters<typeof createCanvasDeletePort>[1]
  confirmation?: CanvasBatchConfirmationPort
}) {
  return {
    canvasBatch: createCanvasBatchPort(options.core, options.publishBatchAndNotes, options.confirmation),
    canvasDeleteNote: createCanvasDeleteNotePort(options.core, options.publishBatchAndNotes, options.confirmation),
    canvasDisconnect: createCanvasDisconnectPort(options.core, options.publishDisconnect, options.confirmation),
    canvasDelete: createCanvasDeletePort(options.core, options.publishDelete, options.confirmation),
  }
}
