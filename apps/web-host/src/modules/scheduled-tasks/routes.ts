import type { FastifyInstance } from 'fastify'
import type { UserFromRequest } from '../../app.js'
import { parsePythonInteger, writeRequestMetadata } from '../../http/request.js'
import { scheduleStatus, taskScheduleKind } from './schedule/status.js'
import { ScheduledTaskNotFound, type createScheduledTaskDeleter } from '@gugu/core/scheduled-task-delete'
import { z } from 'zod'
import { normalizeSchedule, ScheduleValidationError } from '@gugu/core/scheduled-task-schedule'
import type { createPostgresTaskWrites } from './store.js'
import { ScheduledTaskRunNowError } from '@gugu/core/scheduled-task-run-now'
import { type createScheduledTaskTestNotifier, InvalidScheduledTaskDeliveryTarget } from '@gugu/core/scheduled-task-test-notify'

type TaskRow = Record<string, any> & { schedule_kind: unknown; end_at: Date | string | null; enabled: boolean }

const iso = (value: Date | string | null) => value == null ? null : new Date(value).toISOString().replace('.000Z', 'Z')

export const taskPreciseColumns = `to_char(start_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS precise_start,to_char(end_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS precise_end,to_char(last_run_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS precise_last_run`

const precise = (value: unknown, fallback: Date | string | null) => typeof value === 'string' ? value.replace('.000000Z', 'Z') : iso(fallback)

export type ScheduledTaskList = (ownerId: string, eventId: number | null | 'all') => Promise<{ tasks: Array<{ enabled?: boolean; channels?: string[]; schedule_status?: string; schedule_kind?: string; last_run_at?: string | null; last_run_failed?: boolean }> }>

export function taskResponse(t: TaskRow, filesystemAuthorizationEnabled: boolean) {
  return {
      id: Number(t.id), ...(t.execution_mode === 'reminder' ? { execution_mode: 'reminder' as const } : {}), name: t.name, payload: t.payload, cron: t.cron,
      schedule_kind: taskScheduleKind(t), interval_minutes: t.interval_minutes,
      start_at: precise(t.precise_start, t.start_at), end_at: precise(t.precise_end, t.end_at), schedule_status: scheduleStatus(t),
      channels: (t.channels || '').split(',').filter(Boolean), enabled: t.enabled,
      event_id: t.event_id, workspace_id: t.workspace_id,
      filesystem_authorized: filesystemAuthorizationEnabled && t.filesystem_authorization_grant_id != null,
      last_run_at: precise(t.precise_last_run, t.last_run_at), last_run_failed: Boolean(t.last_run_failed),
      delivery_targets: t.delivery_targets, authorized_tools: t.authorized_tools || [],
      email_attachment_file_ids: t.email_attachment_file_ids || [],
    }
}

export function registerScheduledTaskList(app: FastifyInstance, userFromRequest: UserFromRequest, list: ScheduledTaskList) {
  app.get('/api/v1/scheduled-tasks/pending-web-notifications', async request => {
    const { tasks } = await list(userFromRequest(request).requestContext.data.ownerId, 'all')
    return { pending: tasks.some(task => task.enabled && task.schedule_status === 'active'
      && (task.channels?.includes('web') || task.channels?.includes('chat'))
      && (task.schedule_kind !== 'once' || !task.last_run_at)) }
  })
  app.get<{ Querystring: { event_id?: string } }>('/api/v1/scheduled-tasks', async (request, reply) => {
    const id = request.query.event_id === undefined ? null : parsePythonInteger(request.query.event_id)
    if (request.query.event_id !== undefined && id == null) return reply.code(422).send({ detail: '活动标识无效' })
    return list(userFromRequest(request).requestContext.data.ownerId, id ?? null)
  })
}

export function registerScheduledTaskDelete(app: FastifyInstance, userFromRequest: UserFromRequest, remove: ReturnType<typeof createScheduledTaskDeleter>): void {
  app.delete<{ Params: { taskId: string } }>('/api/v1/scheduled-tasks/:taskId', async (request, reply) => {
    const id = parsePythonInteger(request.params.taskId)
    if (id == null) return reply.code(422).send({ detail: '任务标识无效' })
    try {
      await remove(userFromRequest(request).requestContext.data.ownerId, id, writeRequestMetadata(request).clientId)
      return reply.code(204).send()
    } catch (error) {
      if (error instanceof ScheduledTaskNotFound) return reply.code(404).send({ detail: error.message })
      throw error
    }
  })
}

const delivery = z.record(z.string(), z.unknown()).nullable()

const integer = z.preprocess(value => {
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string' && /^[+-]?\d+(?:\.0+)?$/.test(value.trim())) return Number(value.trim())
  return value
}, z.number().int().safe())

const boolean = z.preprocess(value => {
  if (value === 0 || value === 1) return Boolean(value)
  if (typeof value === 'string') {
    if (['true', '1', 'yes', 'on', 'y', 't'].includes(value.toLowerCase())) return true
    if (['false', '0', 'no', 'off', 'n', 'f'].includes(value.toLowerCase())) return false
  }
  return value
}, z.boolean())

const datetime = z.preprocess(value => {
  if (typeof value === 'string' && /^[+-]?\d+(?:\.\d+)?$/.test(value)) value = Number(value)
  if (typeof value === 'number' && Number.isFinite(value)) {
    const seconds = Math.abs(value) > 20_000_000_000 ? value / 1000 : value
    const micros = Math.round(seconds * 1_000_000), millis = Math.floor(micros / 1000)
    const date = new Date(millis)
    if (Number.isFinite(date.getTime())) {
      const fraction = String(((micros % 1_000_000) + 1_000_000) % 1_000_000).padStart(6, '0')
      return `${date.toISOString().slice(0, 20)}${fraction}Z`
    }
  }
  return value
}, z.string().refine(value => {
  try { normalizeSchedule({ schedule_kind: 'interval', interval_minutes: 1, start_at: value }, () => {}, 0); return true }
  catch { return false }
}))

const schema = z.object({
  name: z.string(), payload: z.string(), execution_mode: z.enum(['reminder', 'instruction']).optional(), schedule_kind: z.enum(['once', 'cron', 'interval']),
  cron: z.string().nullable(), interval_minutes: integer.refine(value => value >= 1 && value <= 60).nullable(),
  start_at: datetime.nullable(), end_at: datetime.nullable(), channels: z.array(z.string()),
  enabled: boolean, event_id: integer.nullable(), workspace_id: integer.nullable(),
  authorized_tools: z.array(z.string()), email_attachment_file_ids: z.array(integer).max(5),
  qq_delivery: delivery, im_delivery: delivery,
})

const createSchema = schema.partial().extend({ name: z.string().min(1).max(100), schedule_kind: z.enum(['once', 'cron', 'interval']) })

const updateSchema = schema.omit({ event_id: true }).partial().extend({
  name: z.string().nullish(), payload: z.string().nullish(), execution_mode: z.enum(['reminder', 'instruction']).optional(), schedule_kind: z.enum(['once', 'cron', 'interval']).nullish(),
  channels: z.array(z.string()).nullish(), enabled: boolean.nullish(), authorized_tools: z.array(z.string()).nullish(),
  email_attachment_file_ids: z.array(integer).max(5).nullish(),
})

export function registerScheduledTaskWrites(app: FastifyInstance, userFromRequest: UserFromRequest, writes: ReturnType<typeof createPostgresTaskWrites>) {
  app.post('/api/v1/scheduled-tasks', async (request, reply) => {
    const parsed = createSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(422).send({ detail: '任务参数无效' })
    try {
      const metadata = writeRequestMetadata(request)
      const result = await writes.create(userFromRequest(request).requestContext.data.ownerId, parsed.data, metadata.undoContextId, metadata.clientId)
      return reply.code(result.created ? 201 : 200).send(result.task)
    } catch (error) { return sendError(error, reply) }
  })
  app.patch<{ Params: { taskId: string }; Querystring: { event_id?: string } }>('/api/v1/scheduled-tasks/:taskId', async (request, reply) => {
    const id = parsePythonInteger(request.params.taskId), parsed = updateSchema.safeParse(request.body)
    const eventId = request.query.event_id === undefined ? undefined : parsePythonInteger(request.query.event_id)
    if (id == null || eventId === null || !parsed.success) return reply.code(422).send({ detail: '任务参数无效' })
    try { return await writes.update(userFromRequest(request).requestContext.data.ownerId, id, parsed.data, writeRequestMetadata(request).clientId, eventId) }
    catch (error) { return sendError(error, reply) }
  })
}

function sendError(error: unknown, reply: import('fastify').FastifyReply) {
  if (error instanceof ScheduleValidationError) return reply.code(400).send({ detail: `${error.field}: ${error.message}` })
  if (error instanceof TypeError) return reply.code(400).send({ detail: error.message })
  if (error instanceof Error && 'statusCode' in error && (error.statusCode === 404 || error.statusCode === 409)) return reply.code(error.statusCode).send({ detail: error.message })
  throw error
}

export type ScheduledTaskRunNow = ReturnType<typeof import('@gugu/core/scheduled-task-run-now').createScheduledTaskRunNow>

export function registerScheduledTaskRunNow(app: FastifyInstance, userFromRequest: UserFromRequest, runNow: ScheduledTaskRunNow): void {
  app.post<{ Params: { taskId: string } }>('/api/v1/scheduled-tasks/:taskId/run', async (request, reply) => {
    const id = parsePythonInteger(request.params.taskId)
    if (id == null) return reply.code(422).send({ detail: '任务 ID 无效' })
    try {
      return await runNow(userFromRequest(request).requestContext.data.ownerId, String(id))
    } catch (error) {
      if (error instanceof ScheduledTaskRunNowError && error.code === 'not_found')
        return reply.code(404).send({ detail: '任务不存在' })
      throw error
    }
  })
}

const record = z.record(z.string(), z.unknown()).nullable().optional()

const bodySchema = z.object({
  channels: z.array(z.string()).default(['web']),
  name: z.string().default('活动提醒'),
  qq_delivery: record,
  im_delivery: record,
})

export type ScheduledTaskTestNotifier = ReturnType<typeof createScheduledTaskTestNotifier>

/** Fastify 负责 DTO 和认证上下文，Core 负责旧版消息契约，Host 负责实际渠道投递。 */
export function registerScheduledTaskTestNotify(
  app: FastifyInstance,
  userFromRequest: UserFromRequest,
  notify: ScheduledTaskTestNotifier,
): void {
  app.post('/api/v1/scheduled-tasks/test-notify', async (request, reply) => {
    const parsed = bodySchema.safeParse(request.body)
    if (!parsed.success) return reply.code(422).send({ detail: '测试提醒请求无效' })
    try {
      return await notify(userFromRequest(request).requestContext.data.ownerId, parsed.data)
    } catch (error) {
      if (error instanceof InvalidScheduledTaskDeliveryTarget) return reply.code(400).send({ detail: error.message })
      throw error
    }
  })
}
