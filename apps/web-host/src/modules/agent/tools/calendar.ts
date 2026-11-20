import type { Pool } from 'pg'
import type { CalendarReminderTargetPort } from '@gugu/core/tools'
import type { AgentDispatchLease } from '../run/dispatch.js'
import type { TaskExternalResolution } from '../../scheduled-tasks/store.js'
import type { SqlDataRuntime } from '@gugu/core/data'
import { createAgentCalendarReader, createKyselyCalendarAgentReadPort, createKyselyCalendarReadPort, type EventCreatePublication, type EventUpdatePublication } from '@gugu/core/calendar'
import { createCalendarDeletePort, createCalendarEventCreatePort, createCalendarEventUpdatePort } from '@gugu/core/tools'
import type { CalendarDeleteConfirmationPort } from '@gugu/core/tools'

/** 仅为有效 Web 运行解析 owner 私聊目标；Web 请求不具备可信 QQ 群上下文。 */
export function createWebCalendarReminderTargets(options: {
  pool: Pick<Pool, 'connect'>
  lease: AgentDispatchLease
  delivery: Pick<TaskExternalResolution, 'resolveDelivery'>
  authorize?: () => Promise<boolean>
}): CalendarReminderTargetPort {
  const { lease } = options
  if (!(lease.input.v === 2 && lease.input.source === 'web')
    && !(lease.input.v === 3 && lease.input.source === 'im' && options.authorize)) throw new TypeError('日历提醒运行来源无效')
  const identity = Object.freeze({ ...lease.identity })
  const token = lease.token, fence = lease.fence
  return {
    async resolve(candidate, reminders, signal) {
      signal.throwIfAborted()
      if (candidate.ownerId !== identity.ownerId || candidate.sessionId !== identity.sessionId || candidate.runId !== identity.runId)
        return { ok: false, error: '日历提醒运行身份无效' }
      if (reminders.some(reminder => reminder.delivery_mode === 'current_group'))
        return { ok: false, error: '只有在 QQ 群聊中才能把定时任务绑定到当前群' }
      const client = await options.pool.connect()
      try {
        const isActive = () => client.query(`SELECT 1 FROM conversation_sessions s
          JOIN agent_run_dispatch d ON d.user_id=s.user_id AND d.session_id=s.id
          WHERE s.user_id=$1 AND s.id=$2 AND s.active_run_id=$3 AND d.run_id=$3
            AND d.state='selected' AND d.token=$4 AND d.fence=$5 AND d.lease_expires_at>clock_timestamp()`,
        [identity.ownerId, identity.sessionId, identity.runId, token, fence])
        const active = await isActive()
        signal.throwIfAborted()
        if (active.rowCount !== 1 || options.authorize && !await options.authorize()) return { ok: false, error: '日历提醒运行授权已失效' }
        const resolved = []
        for (const reminder of reminders) {
          const channels = reminder.channels?.length ? [...reminder.channels] : ['web']
          const deliveryTargets = await options.delivery.resolveDelivery(client, identity.ownerId, { channels }, null)
          signal.throwIfAborted()
          resolved.push({ channels, deliveryTargets, enabled: reminder.enabled ?? true })
        }
        const current = await isActive()
        signal.throwIfAborted()
        if (current.rowCount !== 1 || options.authorize && !await options.authorize()) return { ok: false, error: '日历提醒运行授权已失效' }
        return { ok: true, reminders: resolved }
      } finally {
        client.release()
      }
    },
  }
}

/** 同一 Web lease 的日历读写与提醒目标，供可信 Run 资源装配方使用。 */
export function createWebAgentCalendarWritePorts(options: {
  core: SqlDataRuntime
  pool: Pick<Pool, 'connect'>
  lease: AgentDispatchLease
  delivery: Pick<TaskExternalResolution, 'resolveDelivery'>
  authorize?: () => Promise<boolean>
  publishCreate(event: EventCreatePublication): Promise<void>
  publishUpdate(event: EventUpdatePublication): Promise<void>
  publishDelete?: Parameters<typeof createCalendarDeletePort>[1]
  deleteConfirmation?: CalendarDeleteConfirmationPort
}) {
  const targets = createWebCalendarReminderTargets(options)
  const events = createKyselyCalendarAgentReadPort(options.core.db, options.core.backend)
  return {
    calendar: createAgentCalendarReader(events),
    events: createKyselyCalendarReadPort(options.core.db, options.core.backend),
    calendarCreate: createCalendarEventCreatePort(options.core, options.publishCreate, targets),
    calendarUpdate: createCalendarEventUpdatePort(options.core, options.publishUpdate, events, targets),
    ...(options.publishDelete && options.deleteConfirmation ? {
      calendarDelete: createCalendarDeletePort(options.core, options.publishDelete, options.deleteConfirmation),
    } : {}),
  }
}
