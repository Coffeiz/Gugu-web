import type { FastifyInstance } from 'fastify'
import type { UserFromRequest } from '../../app.js'
import { parsePythonInteger } from '../../http/request.js'
import { scheduleStatus, taskScheduleKind } from './schedule-status.js'

type TaskRow = Record<string, any> & { schedule_kind: unknown; end_at: Date | string | null; enabled: boolean }
const iso = (value: Date | string | null) => value == null ? null : new Date(value).toISOString().replace('.000Z', 'Z')
export const taskPreciseColumns = `to_char(start_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS precise_start,to_char(end_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS precise_end,to_char(last_run_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS precise_last_run`
const precise = (value: unknown, fallback: Date | string | null) => typeof value === 'string' ? value.replace('.000000Z', 'Z') : iso(fallback)

export type ScheduledTaskList = (ownerId: string, eventId: number | null) => Promise<{ tasks: unknown[] }>

export function taskResponse(t: TaskRow, filesystemAuthorizationEnabled: boolean) {
  return {
      id: Number(t.id), name: t.name, payload: t.payload, cron: t.cron,
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
  app.get<{ Querystring: { event_id?: string } }>('/api/v1/scheduled-tasks', async (request, reply) => {
    const id = request.query.event_id === undefined ? null : parsePythonInteger(request.query.event_id)
    if (request.query.event_id !== undefined && id == null) return reply.code(422).send({ detail: '活动标识无效' })
    return list(userFromRequest(request).requestContext.data.ownerId, id ?? null)
  })
}
