import { sql } from 'kysely'
import { dataContext } from '../contracts/index.js'
import { databaseTime } from '../data/codec.js'
import { UndoAdapterConflict, UndoAdapterUnsupported, type UndoAdapterContext, type UndoResourceAdapter } from '../undo/state-machine.js'

type Snapshot = Record<string, unknown>
type Items = Record<string, Snapshot>

function state(value: unknown): { items?: Items; undo_versions?: Record<string, unknown> } {
  const decoded = typeof value === 'string' ? JSON.parse(value) : value
  return decoded && typeof decoded === 'object' && !Array.isArray(decoded)
    ? decoded as { items?: Items; undo_versions?: Record<string, unknown> } : {}
}

function projectTarget(row: UndoAdapterContext['row'], mode: 'undo' | 'redo') {
  if (row.action !== 'update' && row.action !== 'create')
    throw new UndoAdapterUnsupported('undo.unsupported', '桌面端暂不支持此项目操作的撤销')
  const before = state(row.before_state).items ?? {}
  const afterState = state(row.after_state)
  const after = afterState.items ?? {}
  const refs = Object.keys(after)
  if (refs.length !== 1 || !/^project:[1-9]\d*$/u.test(refs[0] ?? '')
    || Object.keys(before).some(ref => ref !== refs[0]))
    throw new UndoAdapterUnsupported('undo.unsupported', '项目撤销记录包含桌面端不支持的资源')
  const ref = refs[0]!
  const target = mode === 'undo' ? before[ref] : after[ref]
  if (!target) throw new UndoAdapterConflict('undo.conflict', '项目撤销快照不完整')
  return { ref, id: Number(ref.slice('project:'.length)), target, expected: mode === 'undo' ? after[ref]?.version : afterState.undo_versions?.[ref] }
}

async function updateProjectFields(tx: UndoAdapterContext['tx'], owner: string, id: number, target: Snapshot, now: string) {
  const fields: Record<string, unknown> = {}
  const mappings: Readonly<Record<string, string>> = {
    name: 'name', summary: 'summary', client: 'contact_name', status: 'status',
    start_date: 'start_date', deadline: 'deadline', color: 'color', progress: 'progress',
    current_stage: 'current_stage', priority: 'priority', archived: 'archived', done_at: 'done_at', deleted_at: 'deleted_at',
  }
  for (const [source, destination] of Object.entries(mappings))
    if (source in target) fields[destination] = target[source]
  if ('archived' in fields) fields.archived = fields.archived ? 1 : 0
  if ('stages' in target) fields.stages_json = JSON.stringify(target.stages ?? [])
  fields.updated_at = now
  fields.version = sql<number>`version + 1`
  return tx.updateTable('projects').set(fields as never)
    .where('user_id', '=', owner).where('id', '=', id).returning(['version']).executeTakeFirst()
}

async function updateProjectCreation(tx: UndoAdapterContext['tx'], owner: string, id: number, mode: 'undo' | 'redo', now: string) {
  if (mode === 'undo') {
    const activeEvent = await tx.selectFrom('calendar_events').select('id')
      .where('user_id', '=', owner).where('project_id', '=', id).where('deleted_at', 'is', null).executeTakeFirst()
    if (activeEvent) throw new UndoAdapterUnsupported('undo.unsupported', '该项目已有日历活动，暂不能撤销创建')
  }
  return tx.updateTable('projects').set({
    deleted_at: mode === 'undo' ? now : null,
    updated_at: now,
    version: sql<number>`version + 1`,
  }).where('user_id', '=', owner).where('id', '=', id).returning(['version']).executeTakeFirst()
}

/** 桌面项目目录以 ID 固定定位；只恢复纯项目快照，不触碰 Web 文件库或本地目录。 */
export function createDesktopProjectUndoAdapter(): UndoResourceAdapter {
  return {
    async apply({ tx, owner: rawOwner, row, mode }: UndoAdapterContext) {
      const owner = dataContext(rawOwner).ownerId.replaceAll('-', '')
      const { ref, id, target, expected } = projectTarget(row, mode)
      const current = await tx.selectFrom('projects').selectAll().where('user_id', '=', owner).where('id', '=', id).executeTakeFirst()
      if (!current) throw new UndoAdapterConflict('undo.conflict', '项目不存在，无法安全撤销')
      if (Number(current.version || 1) !== Number(expected ?? -1))
        throw new UndoAdapterConflict('undo.conflict', '项目已被其他操作修改，无法安全撤销')
      const now = databaseTime(new Date().toISOString(), 'sqlite')
      const updated = row.action === 'create'
        ? await updateProjectCreation(tx, owner, id, mode, now)
        : await updateProjectFields(tx, owner, id, target, now)
      if (!updated) throw new UndoAdapterConflict('undo.conflict', '项目已被其他操作修改，无法安全撤销')
      return { versions: { [ref]: Number(updated.version) }, events: [{
        resource: 'projects', operation: row.action === 'create' && mode === 'undo' ? 'delete' : 'update',
        entity_ids: [id], origin: `undo:${row.id}`,
      }] }
    },
  }
}
