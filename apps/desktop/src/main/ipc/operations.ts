import { DESKTOP_CHANNELS } from '@gugu/core/desktop'
import type { IpcHost, IpcHandlers } from './types.js'

export function operationsHandlers(host: IpcHost, diagnostics: () => Promise<unknown>): IpcHandlers {
  return {
    [DESKTOP_CHANNELS.receipt]: (operation: unknown) =>
      host.request('operations.get', { operation_id: operation }),
    [DESKTOP_CHANNELS.sandboxStatus]: diagnostics,
    [DESKTOP_CHANNELS.undoPreview]: (contextId: unknown) =>
      host.request('undo.preview', { context_id: contextId }),
    [DESKTOP_CHANNELS.undoApply]: (contextId: unknown, undoId: unknown, operationId: unknown) =>
      host.request('undo.apply', { context_id: contextId, undo_id: undoId }, operationId as string),
    [DESKTOP_CHANNELS.undoRedo]: (contextId: unknown, undoId: unknown, operationId: unknown) =>
      host.request('undo.redo', { context_id: contextId, undo_id: undoId }, operationId as string),
  }
}
