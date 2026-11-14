import type { PoolClient } from 'pg'
import { recordForwardUndoOperation } from '../../undo/persistence/forward-operation.js'

export async function recordMindNoteUndo(
  client: PoolClient,
  input: {
    ownerId: string
    contextId: string | null
    action: 'create' | 'update' | 'delete'
    noteId: number
    beforeSnapshot: Record<string, unknown> | null
    afterSnapshot: Record<string, unknown>
    baseVersion: number
  },
): Promise<void> {
  const contextId = input.contextId?.trim().slice(0, 128)
  if (!contextId) return
  const key = `note:${input.noteId}`
  await recordForwardUndoOperation(client, {
    userId: input.ownerId,
    contextId,
    resource: 'mind',
    action: input.action,
    targetRefs: [{ kind: 'note', id: input.noteId }],
    beforeState: { items: input.beforeSnapshot ? { [key]: input.beforeSnapshot } : {} },
    afterState: { items: { [key]: input.afterSnapshot } },
    baseVersions: { [key]: { version: input.baseVersion } },
  })
}
