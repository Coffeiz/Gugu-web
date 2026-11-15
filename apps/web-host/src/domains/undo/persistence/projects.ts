import type { PoolClient } from 'pg'
import type { ProjectRecord } from '@gugu/core'
import type { ProjectTrashFile, ProjectTrashFolder, ProjectTrashStorage } from '../../projects/application/project-trash.js'
import { MindUndoConflict, MindUndoUnsupported } from './mind.js'

type Snapshot = Record<string, unknown>
type Items = Record<string, Snapshot>
export interface ProjectUndoStorage {
  trash: ProjectTrashStorage
  renameDirectory(owner: string, oldPrefix: string, newPrefix: string, beforeMove?: (from: string, to: string) => Promise<void>): Promise<void>
}

/** 仅在事务中调用；所有物理变更的补偿由调用方在回滚后逆序执行。 */
export async function applyProjectUndo(client: PoolClient, owner: string, operation: {
  id: string, action: string, before_state: { items?: Items },
  after_state: { items?: Items, undo_versions?: Record<string, unknown> },
}, mode: 'undo' | 'redo', storage: ProjectUndoStorage, rollback: Array<() => Promise<void>>, beforeMove?: (from: string, to: string) => Promise<void>) {
  const after = operation.after_state.items ?? {}
  const before = operation.before_state.items ?? {}
  const tables: Record<string, string> = { project: 'projects', event: 'calendar_events', file: 'files', folder: 'folders', task: 'scheduled_tasks' }
  const rows = new Map<string, Snapshot>()
  for (const [ref, snapshot] of Object.entries(after)) {
    const match = /^(project|event|file|folder|task):(\d+)$/.exec(ref)
    if (!match) throw new MindUndoUnsupported()
    const result = await client.query<Snapshot>(`SELECT * FROM ${tables[match[1]!]!} WHERE id=$1 AND user_id=$2 FOR UPDATE`, [Number(match[2]), owner])
    const row = result.rows[0]
    if (!row) throw new MindUndoConflict('目标对象已不存在，无法安全撤回')
    if (match[1] !== 'task') {
      const expected = mode === 'undo' ? snapshot.version : operation.after_state.undo_versions?.[ref]
      if (Number(row.version ?? 1) !== Number(expected ?? -1)) throw new MindUndoConflict()
    }
    rows.set(ref, row)
  }
  const project = [...rows].find(([key]) => key.startsWith('project:'))?.[1]
  if (!project) throw new MindUndoUnsupported()
  const projectRecord = { ...project, user_id: owner, client: project.contact_name,
    created_at: project.created_at instanceof Date ? project.created_at.toISOString() : String(project.created_at ?? ''),
    start_date: project.start_date instanceof Date ? project.start_date.toISOString().slice(0, 10) : project.start_date,
  } as unknown as ProjectRecord
  const folders = [...rows].filter(([key]) => key.startsWith('folder:')).map(([, row]) => ({ ...row, user_id: owner } as unknown as ProjectTrashFolder))
  const ordered = operation.action === 'delete'
    ? (mode === 'undo' ? ['project', 'folder', 'file', 'event', 'task'] : ['file', 'folder', 'event', 'project', 'task'])
    : ['project', 'event', 'file', 'folder', 'task']
  const versions: Record<string, number> = {}
  for (const kind of ordered) for (const ref of Object.keys(mode === 'redo' && operation.action === 'update' ? before : after).filter(key => key.startsWith(`${kind}:`))) {
    const row = rows.get(ref)
    if (!row) throw new MindUndoConflict()
    const id = Number(ref.split(':')[1])
    const target = mode === 'undo' ? before[ref] : after[ref]
    let updates: Record<string, unknown> = {}
    const deleting = (operation.action === 'create') === (mode === 'undo')
    if (kind === 'project' || kind === 'event') {
      if (operation.action === 'create' || operation.action === 'delete') updates.deleted_at = deleting ? (mode === 'redo' ? after[ref]?.deleted_at ?? new Date() : new Date()) : null
      else if (operation.action === 'update' && kind === 'project' && target) {
        const oldName = String(row.name), newName = String(target.name ?? oldName)
        if (oldName !== newName) {
          const value = row.start_date ?? row.created_at
          const date = (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10)
          const prefix = (name: string) => `${owner}/项目文件/${date.slice(0, 4)}/${date.slice(5, 7)}/${name.replace(/[\\/:*?"<>|]/g, '_')} #${id}`
          const oldKey = prefix(oldName), newKey = prefix(newName)
          await storage.renameDirectory(owner, oldKey, newKey, beforeMove)
          rollback.push(() => storage.renameDirectory(owner, newKey, oldKey))
          await client.query(`UPDATE files SET storage_key=$3 || substring(storage_key from char_length($4)+1) WHERE user_id=$1 AND project_id=$2 AND left(storage_key,char_length($4))=$4`, [owner, id, newKey, oldKey])
        }
        for (const field of ['name', 'summary', 'status', 'start_date', 'deadline', 'color', 'progress', 'current_stage', 'priority', 'archived', 'done_at', 'deleted_at']) if (field in target) updates[field] = target[field]
        if ('client' in target) updates.contact_name = target.client
        updates.stages_json = JSON.stringify(target.stages ?? [])
      } else throw new MindUndoUnsupported()
    } else if (kind === 'folder' && operation.action === 'delete') updates.deleted_at = mode === 'undo' ? null : after[ref]?.deleted_at ?? new Date()
    else if (kind === 'file' && operation.action === 'delete') {
      const file = { ...row, user_id: owner } as unknown as ProjectTrashFile
      const moved = mode === 'undo' ? await storage.trash.restoreFromTrash(owner, file, projectRecord, folders, beforeMove) : await storage.trash.moveToTrash(owner, file, beforeMove)
      if (moved.rollback) rollback.push(moved.rollback)
      updates = { storage_key: moved.storageKey, deleted_at: mode === 'undo' ? null : after[ref]?.deleted_at ?? new Date() }
      if ('displayName' in moved) updates.display_name = moved.displayName
    } else if (kind === 'task' && operation.action === 'delete') updates.enabled = mode === 'undo' ? before[ref]?.enabled ?? row.enabled : false
    else throw new MindUndoUnsupported()
    const fields = Object.keys(updates)
    const version = kind === 'task' ? '' : ', version=COALESCE(version,1)+1'
    const result = await client.query<Snapshot>(`UPDATE ${tables[kind]} SET ${fields.map((field, i) => `${field}=$${i + 3}`).join(', ')}${version} WHERE id=$1 AND user_id=$2 RETURNING *`, [id, owner, ...fields.map(field => updates[field])])
    if (!result.rows[0]) throw new MindUndoConflict()
    versions[ref] = kind === 'task' ? 0 : Number(result.rows[0].version)
  }
  const action = operation.action === 'create' || operation.action === 'delete' ? ((operation.action === 'create') === (mode === 'undo') ? 'delete' : 'create') : 'update'
  const resource: Record<string, string> = { project: 'projects', event: 'calendar', file: 'files', folder: 'files', task: 'scheduled_tasks' }
  const grouped = new Map<string, number[]>()
  for (const ref of Object.keys(versions)) { const [kind, id] = ref.split(':'); const key = resource[kind!]!; grouped.set(key, [...(grouped.get(key) ?? []), Number(id)]) }
  return { versions, events: [...grouped].map(([key, ids]) => ({ resource: key, operation: action, entity_ids: ids, origin: `undo:${operation.id}` })) }
}
