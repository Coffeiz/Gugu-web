import { dataContext } from '../contracts/index.js'
import { UndoAdapterConflict, UndoAdapterUnsupported } from './state-machine.js'
import type { UndoMode, UndoResourceAdapter, UndoRow } from './state-machine.js'

type Snapshot = Record<string, unknown>
type SnapshotItems = Record<string, Snapshot>
type Operation = Pick<UndoRow, 'id' | 'action' | 'before_state' | 'after_state' | 'artifact_refs'>

export interface FileUndoContentRestore {
  restore(input: {
    ownerId: string
    ref: string
    storageKey: string
    artifactRefs: Record<string, unknown>
    mode: UndoMode
  }): Promise<{ rollback(): Promise<void>; finalize(): Promise<void> } | null>
}

const object = (value: unknown): Record<string, unknown> => {
  const decoded = typeof value === 'string' ? JSON.parse(value) : value
  return decoded && typeof decoded === 'object' && !Array.isArray(decoded) ? decoded as Record<string, unknown> : {}
}
const items = (state: unknown): SnapshotItems => {
  const value = object(object(state).items)
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item && typeof item === 'object' && !Array.isArray(item))) as SnapshotItems
}

/** Core 持有文件 Undo 的 owner、版本和元数据规则；正文落盘由 Host 通过受限端口完成。 */
export function createFileUndoAdapter(
  backend: 'sqlite' | 'postgres',
  content: FileUndoContentRestore,
  rollbacks: Array<() => Promise<void>>,
  finalizers: Array<() => Promise<void>>,
): UndoResourceAdapter {
  return {
    async apply({ tx, owner, row, mode }) {
      const operation = row as Operation
      if (!['update', 'overwrite'].includes(operation.action)) throw new UndoAdapterUnsupported('undo.unsupported', '该文件操作类型尚未支持撤销')
      const afterState = object(operation.after_state)
      const before = items(operation.before_state)
      const after = items(operation.after_state)
      const refs = Object.keys(mode === 'undo' ? after : before).sort()
      if (!refs.length || refs.some(ref => !/^file:[1-9]\d*$/.test(ref))) throw new UndoAdapterUnsupported('undo.unsupported', '文件撤销目标无效')

      const canonicalOwner = dataContext(owner).ownerId
      const userId = backend === 'sqlite' ? canonicalOwner.replaceAll('-', '') : canonicalOwner
      const table = tx as unknown as any
      const locked = new Map<string, Record<string, unknown>>()
      for (const ref of refs) {
        const id = Number(ref.slice('file:'.length))
        if (!Number.isSafeInteger(id)) throw new UndoAdapterUnsupported('undo.unsupported', '文件撤销目标无效')
        let query = table.selectFrom('files').selectAll().where('id', '=', id).where('user_id', '=', userId)
        if (backend === 'postgres') query = query.forUpdate()
        const current = await query.executeTakeFirst() as Record<string, unknown> | undefined
        const expected = mode === 'undo' ? after[ref]?.version : object(afterState.undo_versions)[ref]
        if (!current || expected == null || Number(current.version ?? 1) !== Number(expected)) throw new UndoAdapterConflict('undo.conflict', '文件状态已变化，无法撤销')
        const target = mode === 'undo' ? before[ref] : after[ref]
        if (!target || typeof current.storage_key !== 'string' || !current.storage_key.startsWith(`${canonicalOwner}/`))
          throw new UndoAdapterConflict('undo.conflict', '文件归属路径无效，无法撤销')
        if (target.storage_key !== current.storage_key) throw new UndoAdapterUnsupported('undo.unsupported', '文件路径变化的撤销尚未支持')
        locked.set(ref, current)
      }

      const versions: Record<string, number> = {}
      for (const ref of refs) {
        const id = Number(ref.slice('file:'.length))
        const current = locked.get(ref)!
        const target = (mode === 'undo' ? before : after)[ref]!
        const restored = await content.restore({
          ownerId: canonicalOwner,
          ref,
          storageKey: String(current.storage_key),
          artifactRefs: object(operation.artifact_refs),
          mode,
        })
        if (restored) {
          rollbacks.push(restored.rollback)
          finalizers.push(restored.finalize)
        }
        const patch: Record<string, unknown> = { version: Number(current.version ?? 1) + 1 }
        for (const field of ['display_name', 'ext', 'stage_name', 'folder_id', 'project_id', 'workspace_directory_id', 'size', 'size_bytes']) {
          if (Object.hasOwn(target, field)) patch[field] = target[field]
        }
        const result = await table.updateTable('files').set(patch).where('id', '=', id).where('user_id', '=', userId).executeTakeFirst()
        if (Number(result.numUpdatedRows ?? result.numAffectedRows ?? 0) !== 1) throw new UndoAdapterConflict('undo.conflict', '文件状态已变化，无法撤销')
        versions[ref] = patch.version as number
      }
      return { versions, events: [{ resource: 'files', operation: 'update', entity_ids: refs.map(ref => Number(ref.slice('file:'.length))), origin: `undo:${operation.id}` }] }
    },
  }
}
