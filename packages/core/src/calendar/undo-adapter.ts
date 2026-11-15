import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { dataContext } from '../contracts/index.js'
import { databaseTime, nowUtc } from '../data/codec.js'
import type { Backend } from '../data/repositories.js'
import { enqueueCalendarRagIndex } from './create-store.js'
import {
  UndoAdapterConflict,
  UndoAdapterUnsupported,
  type UndoAdapterContext,
  type UndoResourceAdapter,
} from '../undo/state-machine.js'

type Snapshot = Record<string, unknown>
type Items = Record<string, Snapshot>
type CalendarUndoRecord = {
  id: string
  action: string
  before_state: { items?: Items }
  after_state: { items?: Items; undo_versions?: Record<string, unknown> }
}

function state(value: unknown): CalendarUndoRecord['before_state'] {
  const decoded = typeof value === 'string' ? JSON.parse(value) : value
  return decoded && typeof decoded === 'object' && !Array.isArray(decoded) ? decoded as CalendarUndoRecord['before_state'] : {}
}

function valueForTask(field: string, value: unknown, backend: Backend): unknown {
  if (value == null) return null
  if (field === 'enabled' && backend === 'sqlite') return Number(Boolean(value))
  if (field === 'start_at') return databaseTime(value instanceof Date ? value.toISOString() : String(value), backend)
  if (field === 'delivery_targets' && backend === 'sqlite' && typeof value !== 'string') return JSON.stringify(value)
  return value
}

/** Applies calendar Undo snapshots inside the caller's operation/Undo transaction. */
export function createCalendarUndoAdapter(backend: Backend): UndoResourceAdapter {
  return {
    async apply({ tx, owner: rawOwner, row, mode }: UndoAdapterContext) {
      const ownerId = dataContext(rawOwner).ownerId
      const owner = backend === 'sqlite' ? ownerId.replaceAll('-', '') : ownerId
      const operation: CalendarUndoRecord = {
        id: row.id,
        action: row.action,
        before_state: state(row.before_state),
        after_state: state(row.after_state),
      }
      const after = operation.after_state.items ?? {}
      const before = operation.before_state.items ?? {}
      const loaded = new Map<string, Snapshot>()

      for (const [ref] of Object.entries(after)) {
        const match = /^(event|task):(\d+)$/.exec(ref)
        if (!match) throw new UndoAdapterUnsupported('undo.unsupported', '日历撤销记录包含未知资源')
        const kind = match[1]!
        const id = Number(match[2])
        if (!Number.isSafeInteger(id)) throw new UndoAdapterUnsupported('undo.unsupported', '日历撤销记录包含无效标识')
        const table = kind === 'event' ? 'calendar_events' : 'scheduled_tasks'
        const lock = backend === 'postgres' ? sql.raw(' FOR UPDATE') : sql``
        const result = await sql<Snapshot>`SELECT * FROM ${sql.table(table)} WHERE id=${id} AND user_id=${owner}${lock}`.execute(tx)
        const current = result.rows[0]
        if (!current) throw new UndoAdapterConflict('undo.conflict', '目标对象已不存在，无法安全撤回')
        if (kind === 'event') {
          const expected = mode === 'undo' ? after[ref]?.version : operation.after_state.undo_versions?.[ref]
          if (Number(current.version ?? 1) !== Number(expected ?? -1)) throw new UndoAdapterConflict('undo.conflict', '日程已被其他操作修改，无法安全撤回')
        }
        loaded.set(ref, current)
      }

      if (operation.action === 'update') {
        for (const ref of Object.keys(mode === 'undo' ? after : before)) {
          if (ref.startsWith('task:')) {
            const id = Number(ref.slice('task:'.length))
            await sql`UPDATE scheduled_tasks SET cron=${`@once:undo-reschedule-${randomUUID().replaceAll('-', '')}`} WHERE id=${id} AND user_id=${owner}`.execute(tx)
          }
        }
      }

      const targets = mode === 'undo' || operation.action !== 'update' ? after : before
      const versions: Record<string, number> = {}
      const timestamp = databaseTime(nowUtc(), backend)
      for (const ref of Object.keys(targets)) {
        const current = loaded.get(ref)
        if (!current) throw new UndoAdapterConflict('undo.conflict', '撤销目标状态不完整')
        const [kind, rawId] = ref.split(':')
        const id = Number(rawId)
        const target = mode === 'undo' ? before[ref] : after[ref]
        if (kind === 'event') {
          if (operation.action === 'create' || operation.action === 'delete') {
            const deleting = (operation.action === 'create') === (mode === 'undo')
            const deletedAt = deleting
              ? mode === 'redo' ? after[ref]?.deleted_at ?? timestamp : timestamp
              : null
            const result = await sql<{ version: number }>`UPDATE calendar_events SET deleted_at=${deletedAt}, version=COALESCE(version,1)+1 WHERE id=${id} AND user_id=${owner} RETURNING version`.execute(tx)
            if (!result.rows[0]) throw new UndoAdapterConflict('undo.conflict', '日程已不存在，无法安全撤回')
            versions[ref] = Number(result.rows[0].version)
          } else if (operation.action === 'update' && target) {
            const columns: Record<string, string> = {
              title: 'title', date: 'date', time: 'time', end_time: 'end_time', type: 'type',
              client: 'contact_name', project_id: 'project_id', description: 'description', deleted_at: 'deleted_at',
            }
            const fields = Object.keys(columns).filter(field => field in target)
            const assignments = fields.map(field => {
              const value = target[field]
              const normalized = field === 'deleted_at' && value != null ? databaseTime(String(value), backend) : value ?? null
              return sql`${sql.ref(columns[field]!)}=${normalized}`
            })
            assignments.push(sql`version=COALESCE(version,1)+1`)
            const result = await sql<{ version: number }>`UPDATE calendar_events SET ${sql.join(assignments)} WHERE id=${id} AND user_id=${owner} RETURNING version`.execute(tx)
            if (!result.rows[0]) throw new UndoAdapterConflict('undo.conflict', '日程已不存在，无法安全撤回')
            versions[ref] = Number(result.rows[0].version)
          } else {
            throw new UndoAdapterUnsupported('undo.unsupported', '日程撤销操作类型无效')
          }
        } else if (kind === 'task') {
          if (operation.action === 'create' || operation.action === 'delete') {
            const enabled = mode === 'undo'
              ? operation.action === 'create' ? false : before[ref]?.enabled ?? current.enabled
              : operation.action === 'delete' ? false : after[ref]?.enabled ?? true
            await sql`UPDATE scheduled_tasks SET enabled=${valueForTask('enabled', enabled, backend)}, updated_at=${timestamp} WHERE id=${id} AND user_id=${owner}`.execute(tx)
          } else if (operation.action === 'update' && target) {
            const fields = ['enabled', 'name', 'payload', 'cron', 'schedule_kind', 'start_at', 'reminder_lead_minutes', 'channels', 'delivery_targets'].filter(field => field in target)
            const assignments = fields.map(field => sql`${sql.ref(field)}=${valueForTask(field, target[field], backend)}`)
            assignments.push(sql`updated_at=${timestamp}`)
            await sql`UPDATE scheduled_tasks SET ${sql.join(assignments)} WHERE id=${id} AND user_id=${owner}`.execute(tx)
          } else {
            throw new UndoAdapterUnsupported('undo.unsupported', '提醒撤销操作类型无效')
          }
          versions[ref] = 0
        } else {
          throw new UndoAdapterUnsupported('undo.unsupported', '日历撤销记录包含未知资源')
        }
      }

      const action = operation.action === 'create' || operation.action === 'delete'
        ? ((operation.action === 'create') === (mode === 'undo') ? 'delete' : 'create')
        : 'update'
      const indexTimestamp = backend === 'sqlite' ? sql`${databaseTime(nowUtc(), backend)}` : sql`CURRENT_TIMESTAMP`
      for (const ref of Object.keys(versions)) {
        if (ref.startsWith('event:')) {
          await enqueueCalendarRagIndex(tx, backend, owner, ref.slice('event:'.length), indexTimestamp, action)
        }
      }
      const events = ['event', 'task'].map(kind => ({
        resource: kind === 'event' ? 'calendar' : 'scheduled_tasks',
        operation: action,
        entity_ids: Object.keys(versions).filter(ref => ref.startsWith(`${kind}:`)).map(ref => Number(ref.split(':')[1])),
        origin: `undo:${operation.id}`,
      })).filter(event => event.entity_ids.length > 0)
      return { versions, events }
    },
  }
}
