import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { UserFromRequest } from '../../app.js'
import { parsePythonInteger, writeRequestMetadata } from '../../http/request.js'
import { normalizeSchedule, ScheduleValidationError } from '@gugu/core/scheduled-task-schedule'
import type { createPostgresTaskWrites } from './persistence/task-writes-postgres.js'

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
  name: z.string(), payload: z.string(), schedule_kind: z.enum(['once', 'cron', 'interval']),
  cron: z.string().nullable(), interval_minutes: integer.refine(value => value >= 1 && value <= 60).nullable(),
  start_at: datetime.nullable(), end_at: datetime.nullable(), channels: z.array(z.string()),
  enabled: boolean, event_id: integer.nullable(), workspace_id: integer.nullable(),
  authorized_tools: z.array(z.string()), email_attachment_file_ids: z.array(integer).max(5),
  qq_delivery: delivery, im_delivery: delivery,
})
const createSchema = schema.partial().extend({ name: z.string().min(1).max(100), schedule_kind: z.enum(['once', 'cron', 'interval']) })
const updateSchema = schema.omit({ event_id: true }).partial().extend({
  name: z.string().nullish(), payload: z.string().nullish(), schedule_kind: z.enum(['once', 'cron', 'interval']).nullish(),
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
  app.patch<{ Params: { taskId: string } }>('/api/v1/scheduled-tasks/:taskId', async (request, reply) => {
    const id = parsePythonInteger(request.params.taskId), parsed = updateSchema.safeParse(request.body)
    if (id == null || !parsed.success) return reply.code(422).send({ detail: '任务参数无效' })
    try { return await writes.update(userFromRequest(request).requestContext.data.ownerId, id, parsed.data, writeRequestMetadata(request).clientId) }
    catch (error) { return sendError(error, reply) }
  })
}

function sendError(error: unknown, reply: import('fastify').FastifyReply) {
  if (error instanceof ScheduleValidationError) return reply.code(400).send({ detail: `${error.field}: ${error.message}` })
  if (error instanceof TypeError) return reply.code(400).send({ detail: error.message })
  if (error instanceof Error && 'statusCode' in error && (error.statusCode === 404 || error.statusCode === 409)) return reply.code(error.statusCode).send({ detail: error.message })
  throw error
}
