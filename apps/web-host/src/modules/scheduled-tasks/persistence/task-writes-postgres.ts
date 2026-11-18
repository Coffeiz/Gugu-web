import type { Pool, PoolClient } from 'pg'
import { CompiledQuery, type Transaction } from 'kysely'
import type { Database } from '@gugu/core/data'
import { withPostgresTransaction } from '../../../adapters/postgres-transaction.js'
import { normalizeOwnerId } from '../../../adapters/owner-context.js'
import { isPostgresUniqueViolation } from '../../../adapters/postgres-errors.js'
import { scheduleTimestamp, type ScheduleSpec } from '@gugu/core/scheduled-task-schedule'
import {
  createScheduledTask,
  normalizeScheduledTaskChannels,
  normalizeScheduledTaskContext,
  normalizeScheduledTaskTools,
  updateScheduledTask,
  type ScheduledTaskCreateInput,
  type ScheduledTaskPatch,
  type ScheduledTaskPreparedUpdate,
} from '@gugu/core/scheduled-task-write'
import { taskPreciseColumns, taskResponse } from '../task-list.js'
import { scheduledTaskUndoSnapshot } from '@gugu/core/calendar'
import { validateTaskReferences } from './task-resolver-postgres.js'
import { enqueueScheduledTaskRagRebuild } from './task-rag-job-postgres.js'

type TaskWriteQuery = Pick<PoolClient, 'query'>
type Row = Record<string, any> & { schedule_kind: string; end_at: Date | null; enabled: boolean }
export interface ResolvedTaskFields {
  workspace_id: number | null; delivery_targets: unknown; email_attachment_file_ids: number[]; reminder_lead_minutes: number | null
}
export interface TaskWriteOptions {
  validateCron(cron: string): void
  /** 在事务中校验工作区、附件和投递目标的 owner，解析提醒提前量和权限撤销。 */
  resolve(client: TaskWriteQuery, owner: string, input: Record<string, unknown>, schedule: ScheduleSpec, previous: Row | null): Promise<ResolvedTaskFields>
  filesystemAuthorizationEnabled(): boolean
  publish(owner: string, operation: 'create' | 'update', task: unknown, origin: string | null): Promise<void>
}
async function attachReminder(client: TaskWriteQuery, owner: string, contextId: string | null, eventId: number, task: Row): Promise<void> {
  const ctx = normalizeScheduledTaskContext(contextId)
  if (!ctx) return
  const found = await client.query<Row>(`SELECT id,after_state,target_refs,base_versions FROM undo_operations WHERE user_id=$1 AND undo_context_id=$2 AND actor_type='web' AND resource='calendar' AND action='create' AND status='active' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [owner, ctx])
  const operation = found.rows[0]
  if (!operation) return
  const state = operation.after_state ?? {}, items = state.items ?? {}
  if (!items[`event:${eventId}`] || items[`task:${task.id}`]) return
  items[`task:${task.id}`] = scheduledTaskUndoSnapshot(task as any, () => task.precise_start == null ? null : String(task.precise_start).replace('.000000Z', 'Z').replace('Z', '+00:00'))
  await client.query(`UPDATE undo_operations SET after_state=$2::json,target_refs=$3::json,base_versions=$4::json WHERE id=$1`, [operation.id, JSON.stringify({ ...state, items }), JSON.stringify([...(operation.target_refs ?? []), { kind: 'task', id: task.id }]), JSON.stringify({ ...(operation.base_versions ?? {}), [`task:${task.id}`]: { version: 0 } })])
}

type TaskWriteTransaction = <T>(work: (query: TaskWriteQuery) => Promise<T>) => Promise<T>

function taskWrites(transact: TaskWriteTransaction, options: TaskWriteOptions, conflicts?: TaskWriteQuery) {
  const independent = !conflicts
  return {
    create(rawOwner: string, input: ScheduledTaskCreateInput, contextId: string | null, origin: string | null) {
      return createScheduledTask({
        validateCron: options.validateCron,
        persist: async (rawId, input, spec, undoContextId) => {
      const owner = normalizeOwnerId(rawId)
      if (independent && input.event_id != null) throw new TypeError('日历活动提醒由日历工具修改')
      let created = false
      let row: Row
      try {
        row = await transact(async client => {
          await validateTaskReferences(client, owner, input.workspace_id ?? null, input.email_attachment_file_ids ?? [])
          if (input.event_id != null) {
            const event = await client.query('SELECT id FROM calendar_events WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR SHARE', [input.event_id, owner])
            if (!event.rowCount) throw new TypeError('绑定的日历事件不存在')
            const existing = await client.query<Row>(`SELECT *,${taskPreciseColumns} FROM scheduled_tasks WHERE user_id=$1 AND event_id=$2 AND cron=$3`, [owner, input.event_id, spec.cron])
            if (existing.rows[0]) return existing.rows[0]
          }
          const resolved = await options.resolve(client, owner, input as unknown as Record<string, unknown>, spec, null)
          const result = await client.query<Row>(`INSERT INTO scheduled_tasks(user_id,event_id,workspace_id,name,payload,cron,schedule_kind,interval_minutes,start_at,end_at,channels,enabled,delivery_targets,authorized_tools,email_attachment_file_ids,reminder_lead_minutes,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::json,$14::json,$15::json,$16,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) RETURNING *,${taskPreciseColumns}`, [owner, input.event_id ?? null, resolved.workspace_id, input.name, input.payload || '', spec.cron, spec.schedule_kind, spec.interval_minutes, scheduleTimestamp(spec.start_at), scheduleTimestamp(spec.end_at), normalizeScheduledTaskChannels(input.channels ?? ['web']), input.enabled ?? true, JSON.stringify(resolved.delivery_targets ?? null), JSON.stringify(normalizeScheduledTaskTools(input.authorized_tools)), JSON.stringify(resolved.email_attachment_file_ids), resolved.reminder_lead_minutes])
          const task = result.rows[0]!
          if (input.event_id != null) await attachReminder(client, owner, undoContextId, Number(input.event_id), task)
          await enqueueScheduledTaskRagRebuild(client, owner, Number(task.id))
          created = true
          return task
        })
      } catch (error) {
        if (!conflicts || !isPostgresUniqueViolation(error) || input.event_id == null) throw error
        const existing = (await conflicts.query<Row>(`SELECT *,${taskPreciseColumns} FROM scheduled_tasks
          WHERE user_id=$1 AND event_id=$2 AND cron=$3`, [owner, input.event_id, spec.cron])).rows[0]
        if (!existing) throw error
        row = existing
      }
      const response = taskResponse(row, options.filesystemAuthorizationEnabled())
      return { task: response, created }
        },
        publish: (owner, task, from) => options.publish(owner, 'create', task, from),
      }, rawOwner, input, contextId, origin)
    },
    update(rawOwner: string, id: number, patch: ScheduledTaskPatch, origin: string | null) {
      return updateScheduledTask({
        validateCron: options.validateCron,
        persist: async (rawId, taskId, values, prepare) => {
      const owner = normalizeOwnerId(rawId)
      const row = await transact(async client => {
        const found = await client.query<Row>(`SELECT *,to_char(start_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS precise_start,to_char(end_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS precise_end FROM scheduled_tasks WHERE id=$1 AND user_id=$2 ${independent ? 'AND event_id IS NULL' : ''} FOR UPDATE`, [taskId, owner])
        const current = found.rows[0]
        if (!current) throw Object.assign(new Error('任务不存在'), { statusCode: 404 })
        const has = (key: string) => Object.prototype.hasOwnProperty.call(values, key)
        const scheduleKeys = ['schedule_kind', 'cron', 'interval_minutes', 'start_at', 'end_at']
        const scheduleChanged = scheduleKeys.some(has)
        const coreCurrent = {
          schedule_kind: String(current.schedule_kind), cron: String(current.cron),
          interval_minutes: current.interval_minutes == null ? null : Number(current.interval_minutes),
          start_at: current.precise_start as string | null, end_at: current.precise_end as string | null,
          event_id: current.event_id == null ? null : Number(current.event_id),
        }
        const retainedSchedule: ScheduleSpec = {
          schedule_kind: current.schedule_kind, cron: current.cron, interval_minutes: current.interval_minutes,
          start_at: current.start_at == null ? null : new Date(current.start_at),
          end_at: current.end_at == null ? null : new Date(current.end_at),
        }
        let resolved: ResolvedTaskFields | undefined
        const prepared: ScheduledTaskPreparedUpdate = await prepare(coreCurrent, async (_task, nextPatch, schedule) => {
          const spec: ScheduleSpec = schedule ?? retainedSchedule
          if (scheduleChanged && current.event_id != null && schedule) {
            const event = await client.query('SELECT id FROM calendar_events WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR SHARE', [current.event_id, owner])
            if (!event.rowCount) throw new TypeError('绑定的日历事件不存在')
            const conflict = await client.query('SELECT id FROM scheduled_tasks WHERE user_id=$1 AND event_id=$2 AND cron=$3 AND id<>$4', [owner, current.event_id, spec.cron, taskId])
            if (conflict.rowCount) throw Object.assign(new Error('该活动在同一触发时刻已有提醒'), { statusCode: 409 })
          }
          resolved = await options.resolve(client, owner, nextPatch, spec, current)
        })
        const spec = prepared.schedule ?? retainedSchedule
        const normalizedPatch = prepared.patch
        const resolvedFields = resolved!
        const nextChannels = has('channels') && normalizedPatch.channels != null ? normalizeScheduledTaskChannels(normalizedPatch.channels) : current.channels
        const nextTools = has('authorized_tools') && normalizedPatch.authorized_tools != null ? normalizeScheduledTaskTools(normalizedPatch.authorized_tools)
          : has('payload') && normalizedPatch.payload != null || scheduleKeys.some(has) || has('channels') && normalizedPatch.channels != null ? [] : current.authorized_tools
        const result = await client.query<Row>(`UPDATE scheduled_tasks SET name=$3,payload=$4,cron=$5,schedule_kind=$6,interval_minutes=$7,start_at=CASE WHEN $17::boolean THEN $8::timestamptz ELSE start_at END,end_at=CASE WHEN $17::boolean THEN $9::timestamptz ELSE end_at END,channels=$10,enabled=$11,workspace_id=$12,delivery_targets=$13::json,authorized_tools=$14::json,email_attachment_file_ids=$15::json,reminder_lead_minutes=$16,updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND user_id=$2 RETURNING *,${taskPreciseColumns}`, [taskId, owner, normalizedPatch.name ?? current.name, normalizedPatch.payload ?? current.payload, spec.cron, spec.schedule_kind, spec.interval_minutes, scheduleTimestamp(spec.start_at), scheduleTimestamp(spec.end_at), nextChannels, normalizedPatch.enabled ?? current.enabled, resolvedFields.workspace_id, JSON.stringify(resolvedFields.delivery_targets ?? null), JSON.stringify(nextTools ?? []), JSON.stringify(resolvedFields.email_attachment_file_ids), resolvedFields.reminder_lead_minutes, scheduleChanged])
        await enqueueScheduledTaskRagRebuild(client, owner, taskId)
        return result.rows[0]!
      })
      const response = taskResponse(row, options.filesystemAuthorizationEnabled())
      return response
        },
        publish: (owner, task, from) => options.publish(owner, 'update', task, from),
      }, rawOwner, id, patch, origin)
    },
  }
}

/** Web REST 拥有事务，提交后发布；活动提醒去重保留原语义。 */
export function createPostgresTaskWrites(pool: Pool, options: TaskWriteOptions) {
  return taskWrites(work => withPostgresTransaction(pool, work), options, pool)
}

/** Agent 只修改独立任务，调度校验及写入借用外层确认和调用收据事务。 */
export function createBorrowedPostgresTaskWrites(tx: Transaction<Database>, options: Omit<TaskWriteOptions, 'publish'>) {
  const query = async <Row>(text: string, parameters: unknown[] = []) => {
    const result = await tx.getExecutor().executeQuery<Row>(CompiledQuery.raw(text, parameters))
    return { rows: result.rows, rowCount: Number(result.numAffectedRows ?? result.rows.length) }
  }
  // 本方法只承诺写入外层事务；调用者在提交成功后按领域回执通知。
  return taskWrites(work => work({ query: query as PoolClient['query'] }), { ...options, async publish() {} })
}
