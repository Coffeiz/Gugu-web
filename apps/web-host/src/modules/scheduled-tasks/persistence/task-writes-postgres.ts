import type { Pool, PoolClient } from 'pg'
import { withPostgresTransaction } from '../../../adapters/postgres-transaction.js'
import { normalizeOwnerId } from '../../../adapters/owner-context.js'
import { isPostgresUniqueViolation } from '../../../adapters/postgres-errors.js'
import { normalizeSchedule, scheduleTimestamp, type ScheduleSpec } from '../normalize-schedule.js'
import { taskPreciseColumns, taskResponse } from '../task-list.js'
import { scheduledTaskUndoSnapshot } from '@gugu/core/calendar'
import { validateTaskReferences } from './task-resolver-postgres.js'
import type { TaskCreateInput } from '../task-create.js'

type Row = Record<string, any> & { schedule_kind: string; end_at: Date | null; enabled: boolean }
export interface ResolvedTaskFields {
  workspace_id: number | null; delivery_targets: unknown; email_attachment_file_ids: number[]; reminder_lead_minutes: number | null
}
export interface TaskWriteOptions {
  validateCron(cron: string): void
  /** 在事务中校验工作区、附件和投递目标的 owner，解析提醒提前量和权限撤销。 */
  resolve(client: PoolClient, owner: string, input: Record<string, unknown>, schedule: ScheduleSpec, previous: Row | null): Promise<ResolvedTaskFields>
  filesystemAuthorizationEnabled(): boolean
  publish(owner: string, operation: 'create' | 'update', task: unknown, origin: string | null): Promise<void>
}
const channels = new Set(['web', 'email', 'feishu', 'qq', 'wechat', 'telegram', 'im', 'chat'])
const normalizeChannels = (value: unknown): string => {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new TypeError('channels 必须是字符串数组')
  const result = [...new Set(value.filter((item): item is string => typeof item === 'string' && channels.has(item)))]
  return result.length ? result.join(',') : 'web'
}
const tools = (value: unknown) => {
  if (value == null) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new TypeError('authorized_tools 必须是字符串数组')
  return value.includes('send_email') ? ['send_email'] : []
}
const context = (value: string | null) => value?.trim().slice(0, 128) || null
function validateFields(input: Record<string, unknown>, create: boolean): void {
  if (create || input.name != null) {
    if (typeof input.name !== 'string' || (create && (!input.name.length || [...input.name].length > 100))) throw new TypeError('任务名称无效')
  }
  if (input.payload != null && typeof input.payload !== 'string') throw new TypeError('任务内容无效')
  if (input.enabled != null && typeof input.enabled !== 'boolean') throw new TypeError('enabled 必须是布尔值')
  if (input.channels != null) normalizeChannels(input.channels)
  if (input.authorized_tools != null) tools(input.authorized_tools)
}

async function attachReminder(client: PoolClient, owner: string, contextId: string | null, eventId: number, task: Row): Promise<void> {
  const ctx = context(contextId)
  if (!ctx) return
  const found = await client.query<Row>(`SELECT id,after_state,target_refs,base_versions FROM undo_operations WHERE user_id=$1 AND undo_context_id=$2 AND actor_type='web' AND resource='calendar' AND action='create' AND status='active' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [owner, ctx])
  const operation = found.rows[0]
  if (!operation) return
  const state = operation.after_state ?? {}, items = state.items ?? {}
  if (!items[`event:${eventId}`] || items[`task:${task.id}`]) return
  items[`task:${task.id}`] = scheduledTaskUndoSnapshot(task as any, () => task.precise_start == null ? null : String(task.precise_start).replace('.000000Z', 'Z').replace('Z', '+00:00'))
  await client.query(`UPDATE undo_operations SET after_state=$2::json,target_refs=$3::json,base_versions=$4::json WHERE id=$1`, [operation.id, JSON.stringify({ ...state, items }), JSON.stringify([...(operation.target_refs ?? []), { kind: 'task', id: task.id }]), JSON.stringify({ ...(operation.base_versions ?? {}), [`task:${task.id}`]: { version: 0 } })])
}

/** CRUD 使用事务持锁；外部能力不可用时 resolve 必须抛错。 */
export function createPostgresTaskWrites(pool: Pool, options: TaskWriteOptions) {
  return {
    async create(rawOwner: string, input: TaskCreateInput, contextId: string | null, origin: string | null) {
      const owner = normalizeOwnerId(rawOwner)
      validateFields(input as unknown as Record<string, unknown>, true)
      const spec = normalizeSchedule(input, options.validateCron)
      if (input.event_id != null && spec.schedule_kind !== 'once') throw new TypeError('日历活动提醒必须使用 once 类型')
      const findExisting = async () => (await pool.query<Row>(`SELECT *,${taskPreciseColumns} FROM scheduled_tasks WHERE user_id=$1 AND event_id=$2 AND cron=$3`, [owner, input.event_id, spec.cron])).rows[0]
      let created = false
      let row: Row
      try {
        row = await withPostgresTransaction(pool, async client => {
          await validateTaskReferences(client, owner, input.workspace_id ?? null, input.email_attachment_file_ids ?? [])
          if (input.event_id != null) {
            const event = await client.query('SELECT id FROM calendar_events WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR SHARE', [input.event_id, owner])
            if (!event.rowCount) throw new TypeError('绑定的日历事件不存在')
            const existing = await client.query<Row>(`SELECT *,${taskPreciseColumns} FROM scheduled_tasks WHERE user_id=$1 AND event_id=$2 AND cron=$3`, [owner, input.event_id, spec.cron])
            if (existing.rows[0]) return existing.rows[0]
          }
          const resolved = await options.resolve(client, owner, input as unknown as Record<string, unknown>, spec, null)
          const result = await client.query<Row>(`INSERT INTO scheduled_tasks(user_id,event_id,workspace_id,name,payload,cron,schedule_kind,interval_minutes,start_at,end_at,channels,enabled,delivery_targets,authorized_tools,email_attachment_file_ids,reminder_lead_minutes,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::json,$14::json,$15::json,$16,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) RETURNING *,${taskPreciseColumns}`, [owner, input.event_id ?? null, resolved.workspace_id, input.name, input.payload || '', spec.cron, spec.schedule_kind, spec.interval_minutes, scheduleTimestamp(spec.start_at), scheduleTimestamp(spec.end_at), normalizeChannels(input.channels ?? ['web']), input.enabled ?? true, JSON.stringify(resolved.delivery_targets ?? null), JSON.stringify(tools(input.authorized_tools)), JSON.stringify(resolved.email_attachment_file_ids), resolved.reminder_lead_minutes])
          const task = result.rows[0]!
          if (input.event_id != null) await attachReminder(client, owner, contextId, input.event_id, task)
          created = true
          return task
        })
      } catch (error) {
        if (!isPostgresUniqueViolation(error) || input.event_id == null) throw error
        const existing = await findExisting()
        if (!existing) throw error
        row = existing
      }
      const response = taskResponse(row, options.filesystemAuthorizationEnabled())
      if (created) await options.publish(owner, 'create', response, origin)
      return response
    },
    async update(rawOwner: string, id: number, patch: Record<string, unknown>, origin: string | null) {
      const owner = normalizeOwnerId(rawOwner)
      validateFields(patch, false)
      const row = await withPostgresTransaction(pool, async client => {
        const found = await client.query<Row>(`SELECT *,to_char(start_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS precise_start,to_char(end_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS precise_end FROM scheduled_tasks WHERE id=$1 AND user_id=$2 FOR UPDATE`, [id, owner])
        const current = found.rows[0]
        if (!current) throw Object.assign(new Error('任务不存在'), { statusCode: 404 })
        const has = (key: string) => Object.prototype.hasOwnProperty.call(patch, key)
        const scheduleKeys = ['schedule_kind', 'cron', 'interval_minutes', 'start_at', 'end_at']
        let spec: ScheduleSpec = { schedule_kind: current.schedule_kind, cron: current.cron, interval_minutes: current.interval_minutes, start_at: current.start_at, end_at: current.end_at }
        const scheduleChanged = scheduleKeys.some(has)
        if (scheduleChanged) {
          const kind = has('schedule_kind') ? patch.schedule_kind : current.schedule_kind
          const changed = kind !== current.schedule_kind
          const dateValue = (key: string) => { const value = has(key) ? patch[key] : changed ? null : current[key === 'start_at' ? 'precise_start' : 'precise_end']; return value as string | null }
          spec = normalizeSchedule({ schedule_kind: kind as string, cron: (has('cron') ? patch.cron : changed || kind !== 'cron' ? null : current.cron) as string | null,
            interval_minutes: (has('interval_minutes') ? patch.interval_minutes : changed ? null : current.interval_minutes) as number | null,
            start_at: dateValue('start_at'), end_at: dateValue('end_at') }, options.validateCron)
          if (current.event_id != null && spec.schedule_kind !== 'once') throw new TypeError('日历活动提醒必须使用 once 类型')
          if (current.event_id != null) {
            const event = await client.query('SELECT id FROM calendar_events WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR SHARE', [current.event_id, owner])
            if (!event.rowCount) throw new TypeError('绑定的日历事件不存在')
            const conflict = await client.query('SELECT id FROM scheduled_tasks WHERE user_id=$1 AND event_id=$2 AND cron=$3 AND id<>$4', [owner, current.event_id, spec.cron, id])
            if (conflict.rowCount) throw Object.assign(new Error('该活动在同一触发时刻已有提醒'), { statusCode: 409 })
          }
        }
        const resolved = await options.resolve(client, owner, patch, spec, current)
        const nextChannels = has('channels') && patch.channels != null ? normalizeChannels(patch.channels) : current.channels
        const nextTools = has('authorized_tools') && patch.authorized_tools != null ? tools(patch.authorized_tools)
          : has('payload') && patch.payload != null || scheduleKeys.some(has) || has('channels') && patch.channels != null ? [] : current.authorized_tools
        const result = await client.query<Row>(`UPDATE scheduled_tasks SET name=$3,payload=$4,cron=$5,schedule_kind=$6,interval_minutes=$7,start_at=CASE WHEN $17::boolean THEN $8::timestamptz ELSE start_at END,end_at=CASE WHEN $17::boolean THEN $9::timestamptz ELSE end_at END,channels=$10,enabled=$11,workspace_id=$12,delivery_targets=$13::json,authorized_tools=$14::json,email_attachment_file_ids=$15::json,reminder_lead_minutes=$16,updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND user_id=$2 RETURNING *,${taskPreciseColumns}`, [id, owner, patch.name ?? current.name, patch.payload ?? current.payload, spec.cron, spec.schedule_kind, spec.interval_minutes, scheduleTimestamp(spec.start_at), scheduleTimestamp(spec.end_at), nextChannels, patch.enabled ?? current.enabled, resolved.workspace_id, JSON.stringify(resolved.delivery_targets ?? null), JSON.stringify(nextTools ?? []), JSON.stringify(resolved.email_attachment_file_ids), resolved.reminder_lead_minutes, scheduleChanged])
        return result.rows[0]!
      })
      const response = taskResponse(row, options.filesystemAuthorizationEnabled())
      await options.publish(owner, 'update', response, origin)
      return response
    },
  }
}
