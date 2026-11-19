import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { MindUndoConflict, MindUndoUnsupported } from './mind.js'
import { enqueueScheduledTaskRagRebuild } from '../../scheduled-tasks/persistence/task-rag-job-postgres.js'

type Snapshot = Record<string, unknown>
type Items = Record<string, Snapshot>

/** 调用方在事务中锁定撤销记录；返回事件只能在提交后发布。 */
export async function applyCalendarUndo(client: PoolClient, ownerId: string, operation: {
  id: string, action: string, before_state: { items?: Items },
  after_state: { items?: Items, undo_versions?: Record<string, unknown> },
}, mode: 'undo' | 'redo'): Promise<{ versions: Record<string, number>, events: Array<Record<string, unknown>> }> {
  const after = operation.after_state.items ?? {}
  const before = operation.before_state.items ?? {}
  const rows = new Map<string, Snapshot>()
  for (const [ref, snapshot] of Object.entries(after)) {
    const match = /^(event|task):(\d+)$/.exec(ref)
    if (!match) throw new MindUndoUnsupported()
    const table = match[1] === 'event' ? 'calendar_events' : 'scheduled_tasks'
    const result = await client.query<Snapshot>(`SELECT * FROM ${table} WHERE id=$1 AND user_id=$2 FOR UPDATE`, [Number(match[2]), ownerId])
    const row = result.rows[0]
    if (!row) throw new MindUndoConflict('目标对象已不存在，无法安全撤回')
    if (match[1] === 'event') {
      const expected = mode === 'undo' ? snapshot.version : operation.after_state.undo_versions?.[ref]
      if (Number(row.version ?? 1) !== Number(expected ?? -1)) throw new MindUndoConflict()
    }
    rows.set(ref, row)
  }
  if (operation.action === 'update') {
    for (const ref of Object.keys(mode === 'undo' ? after : before)) {
      if (ref.startsWith('task:')) await client.query('UPDATE scheduled_tasks SET cron=$3 WHERE id=$1 AND user_id=$2', [Number(ref.slice(5)), ownerId, `@once:undo-reschedule-${randomUUID().replaceAll('-', '')}`])
    }
  }
  const versions: Record<string, number> = {}
  const items = mode === 'undo' || operation.action !== 'update' ? after : before
  for (const ref of Object.keys(items)) {
    const row = rows.get(ref)
    if (!row) throw new MindUndoConflict()
    const [kind, rawId] = ref.split(':')
    const id = Number(rawId)
    const target = mode === 'undo' ? before[ref] : after[ref]
    if (kind === 'event') {
      if (operation.action === 'create' || operation.action === 'delete') {
        const deleting = (operation.action === 'create') === (mode === 'undo')
        const result = await client.query<Snapshot>('UPDATE calendar_events SET deleted_at=$3, version=COALESCE(version,1)+1 WHERE id=$1 AND user_id=$2 RETURNING version', [id, ownerId, deleting ? (mode === 'redo' ? after[ref]?.deleted_at ?? new Date() : new Date()) : null])
        versions[ref] = Number(result.rows[0]?.version)
      } else if (operation.action === 'update' && target) {
        const fields = ['title', 'date', 'time', 'end_time', 'type', 'client', 'project_id', 'description', 'deleted_at'].filter(field => field in target)
        const result = await client.query<Snapshot>(`UPDATE calendar_events SET ${fields.map((field, i) => `${field === 'client' ? 'contact_name' : field}=$${i + 3}`).join(', ')}, version=COALESCE(version,1)+1 WHERE id=$1 AND user_id=$2 RETURNING version`, [id, ownerId, ...fields.map(field => target[field])])
        versions[ref] = Number(result.rows[0]?.version)
      } else throw new MindUndoUnsupported()
    } else if (kind === 'task') {
      if (operation.action === 'create' || operation.action === 'delete') {
        const enabled = mode === 'undo' ? (operation.action === 'create' ? false : before[ref]?.enabled ?? row.enabled) : (operation.action === 'delete' ? false : after[ref]?.enabled ?? true)
        await client.query('UPDATE scheduled_tasks SET enabled=$3 WHERE id=$1 AND user_id=$2', [id, ownerId, enabled])
      } else if (operation.action === 'update' && target) {
        const fields = ['enabled', 'name', 'payload', 'cron', 'schedule_kind', 'start_at', 'reminder_lead_minutes', 'channels', 'delivery_targets'].filter(field => field in target)
        await client.query(`UPDATE scheduled_tasks SET ${fields.map((field, i) => `${field}=$${i + 3}`).join(', ')} WHERE id=$1 AND user_id=$2`, [id, ownerId, ...fields.map(field => target[field])])
      } else throw new MindUndoUnsupported()
      await enqueueScheduledTaskRagRebuild(client, ownerId, id)
      versions[ref] = 0
    } else throw new MindUndoUnsupported()
  }
  const action = operation.action === 'create' || operation.action === 'delete' ? ((operation.action === 'create') === (mode === 'undo') ? 'delete' : 'create') : 'update'
  const events = ['event', 'task'].map(kind => ({ resource: kind === 'event' ? 'calendar' : 'scheduled_tasks', operation: action, entity_ids: Object.keys(versions).filter(ref => ref.startsWith(`${kind}:`)).map(ref => Number(ref.split(':')[1])), origin: `undo:${operation.id}` })).filter(event => event.entity_ids.length)
  return { versions, events }
}
