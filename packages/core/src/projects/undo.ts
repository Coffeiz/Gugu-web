import type { ProjectRecord } from '../contracts/index.js'
import { UndoAdapterConflict, UndoAdapterUnsupported } from '../undo/state-machine.js'
import type { ProjectTrashFile, ProjectTrashStorage } from './project-trash.js'

type Snapshot = Record<string, unknown>
type Items = Record<string, Snapshot>
/** 项目等资源保留既有行标识，文件撤销通过存储路径定位。 */
export type ProjectUndoKind = 'project' | 'event' | 'file' | 'task'
/** 读取/行锁和后续写入必须共用外层事务；SQLite 由事务写锁保护。 */
export interface ProjectUndoTransaction {
  getOwned(kind: ProjectUndoKind, idOrPath: number | string, owner: string): Promise<Snapshot | null>
  update(kind: ProjectUndoKind, idOrPath: number | string, owner: string, fields: Snapshot): Promise<Snapshot | null>
  updateProjectFilePaths?(owner: string, projectId: number, oldPrefix: string, newPrefix: string): Promise<void>
}
export interface ProjectUndoStorage {
  trash: ProjectTrashStorage
  renameDirectory(owner: string, oldPrefix: string, newPrefix: string, beforeMove?: (from: string, to: string) => Promise<void>): Promise<void>
}

export interface ProjectUndoMove { from: string; to: string }
export interface ProjectUndoJournalStorage {
  exists(ownerId: string, path: string): Promise<boolean>
  move(ownerId: string, from: string, to: string): Promise<void>
}

/** Host 持有恢复锁并读取持久终态；Core 决定正向完成或逆序补偿，不猜测未知提交结果。 */
export async function recoverProjectFileMoves(journal: {
  ownerId: string; beforeStatus: string; afterStatus: string; moves: readonly ProjectUndoMove[]
}, status: string | undefined, storage: ProjectUndoJournalStorage): Promise<void> {
  if (status !== journal.beforeStatus && status !== journal.afterStatus) throw new Error('撤销操作状态与文件日志不一致')
  const committed = status === journal.afterStatus
  for (const move of committed ? journal.moves : [...journal.moves].reverse()) {
    const from = committed ? move.from : move.to, to = committed ? move.to : move.from
    const source = await storage.exists(journal.ownerId, from), target = await storage.exists(journal.ownerId, to)
    if (source && !target) await storage.move(journal.ownerId, from, to)
    else if (source || !target) throw new Error('撤销文件日志路径状态不明确')
  }
}

/** 仅在事务中调用；所有物理变更的补偿由调用方在回滚后逆序执行。 */
export async function applyProjectUndo(tx: ProjectUndoTransaction, owner: string, operation: {
  id: string, action: string, before_state: { items?: Items },
  after_state: { items?: Items, undo_versions?: Record<string, unknown> },
}, mode: 'undo' | 'redo', storage: ProjectUndoStorage, rollback: Array<() => Promise<void>>, beforeMove?: (from: string, to: string) => Promise<void>) {
  const after = operation.after_state.items ?? {}
  const before = operation.before_state.items ?? {}
  const rows = new Map<string, Snapshot>()
  for (const [ref, snapshot] of Object.entries(after)) {
    const fileRef = /^file:(.+)$/.exec(ref)
    const match = /^(project|event|task):(\d+)$/.exec(ref)
    if (!match && !fileRef) throw new UndoAdapterUnsupported('undo.unsupported', '项目操作类型尚未支持撤回')
    const kind = fileRef ? 'file' : match![1] as ProjectUndoKind
    const idOrPath = fileRef ? mode === 'undo' ? snapshot.path : before[ref]?.path : Number(match![2])
    if (typeof idOrPath !== 'string' && (typeof idOrPath !== 'number' || !Number.isSafeInteger(idOrPath)))
      throw new UndoAdapterUnsupported('undo.unsupported', '项目文件路径快照无效')
    const row = await tx.getOwned(kind, idOrPath, owner)
    if (!row) throw new UndoAdapterConflict('undo.conflict', '目标对象已不存在，无法安全撤回')
    if (kind !== 'task') {
      const expected = mode === 'undo' ? snapshot.version : operation.after_state.undo_versions?.[ref]
      if (Number(row.version ?? 1) !== Number(expected ?? -1)) throw new UndoAdapterConflict('undo.conflict', '目标对象已变化，无法安全撤回')
    }
    rows.set(ref, row)
  }
  const project = [...rows].find(([key]) => key.startsWith('project:'))?.[1]
  if (!project) throw new UndoAdapterUnsupported('undo.unsupported', '项目操作类型尚未支持撤回')
  const projectRecord = { ...project, user_id: owner, client: project.contact_name,
    created_at: project.created_at instanceof Date ? project.created_at.toISOString() : String(project.created_at ?? ''),
    start_date: project.start_date instanceof Date ? project.start_date.toISOString().slice(0, 10) : project.start_date,
  } as unknown as ProjectRecord
  const ordered = operation.action === 'delete'
    ? (mode === 'undo' ? ['project', 'file', 'event', 'task'] : ['file', 'event', 'project', 'task'])
    : ['project', 'event', 'file', 'task']
  const versions: Record<string, number> = {}
  for (const kind of ordered) for (const ref of Object.keys(mode === 'redo' && operation.action === 'update' ? before : after).filter(key => key.startsWith(`${kind}:`))) {
    const row = rows.get(ref)
    if (!row) throw new UndoAdapterConflict('undo.conflict', '目标对象已变化，无法安全撤回')
    const target = mode === 'undo' ? before[ref] : after[ref]
    const fileRef = kind === 'file' ? /^file:(.+)$/.exec(ref) : null
    const idOrPath = fileRef ? mode === 'undo' ? after[ref]?.path : before[ref]?.path : Number(ref.split(':')[1])
    if (typeof idOrPath !== 'string' && (typeof idOrPath !== 'number' || !Number.isSafeInteger(idOrPath)))
      throw new UndoAdapterUnsupported('undo.unsupported', '项目文件路径快照无效')
    const id = typeof idOrPath === 'number' ? idOrPath : 0
    let updates: Record<string, unknown> = {}
    const deleting = (operation.action === 'create') === (mode === 'undo')
    if (kind === 'project' || kind === 'event') {
      if (operation.action === 'create' || operation.action === 'delete') {
        if (kind === 'project' && ![...rows].some(([key, file]) => key.startsWith('file:') && Number(file.project_id) === id)) {
          const undoDirectory = await storage.trash.moveProjectDirectory?.(owner, { ...row, id } as unknown as ProjectRecord, deleting, beforeMove)
          if (undoDirectory) rollback.push(undoDirectory)
        }
        updates.deleted_at = deleting ? (mode === 'redo' ? after[ref]?.deleted_at ?? new Date() : new Date()) : null
      }
      else if (operation.action === 'update' && kind === 'project' && target) {
        const oldName = String(row.name), newName = String(target.name ?? oldName)
        if (oldName !== newName) {
          const value = row.start_date ?? row.created_at
          const date = (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10)
          const prefix = (name: string) => `${owner}/项目文件/${date.slice(0, 4)}/${date.slice(5, 7)}/${name.replace(/[\\/:*?"<>|]/g, '_')} #${id}`
          const oldKey = prefix(oldName), newKey = prefix(newName)
          await storage.renameDirectory(owner, oldKey, newKey, beforeMove)
          rollback.push(() => storage.renameDirectory(owner, newKey, oldKey))
          if (!tx.updateProjectFilePaths) throw new UndoAdapterUnsupported('undo.unsupported', '项目文件路径更新端口尚未接入')
          await tx.updateProjectFilePaths(owner, id, oldKey, newKey)
        }
        for (const field of ['name', 'summary', 'status', 'start_date', 'deadline', 'color', 'progress', 'current_stage', 'priority', 'archived', 'done_at', 'deleted_at']) if (field in target) updates[field] = target[field]
        if ('client' in target) updates.contact_name = target.client
        updates.stages_json = JSON.stringify(target.stages ?? [])
      } else throw new UndoAdapterUnsupported('undo.unsupported', '项目操作类型尚未支持撤回')
    } else if (kind === 'file' && operation.action === 'delete') {
      const file = { ...row, user_id: owner } as unknown as ProjectTrashFile
      const moved = mode === 'undo' ? await storage.trash.restoreFromTrash(owner, file, projectRecord, beforeMove) : await storage.trash.moveToTrash(owner, file, beforeMove)
      if (moved.rollback) rollback.push(moved.rollback)
      updates = { path: moved.storageKey, deleted_at: mode === 'undo' ? null : after[ref]?.deleted_at ?? new Date() }
      if ('displayName' in moved) updates.display_name = moved.displayName
    } else if (kind === 'task' && operation.action === 'delete') updates.enabled = mode === 'undo' ? before[ref]?.enabled ?? row.enabled : false
    else throw new UndoAdapterUnsupported('undo.unsupported', '项目操作类型尚未支持撤回')
    const updated = await tx.update(kind as ProjectUndoKind, idOrPath, owner, updates)
    if (!updated) throw new UndoAdapterConflict('undo.conflict', '目标对象已变化，无法安全撤回')
    versions[ref] = kind === 'task' ? 0 : Number(updated.version)
  }
  const action = operation.action === 'create' || operation.action === 'delete' ? ((operation.action === 'create') === (mode === 'undo') ? 'delete' : 'create') : 'update'
  const resource: Record<string, string> = { project: 'projects', event: 'calendar', task: 'scheduled_tasks' }
  const grouped = new Map<string, number[]>()
  for (const ref of Object.keys(versions)) {
    const [kind, id] = ref.split(':')
    const key = resource[kind!]
    if (key) grouped.set(key, [...(grouped.get(key) ?? []), Number(id)])
  }
  return { versions, events: [...grouped].map(([key, ids]) => ({ resource: key, operation: action, entity_ids: ids, origin: `undo:${operation.id}` })) }
}
