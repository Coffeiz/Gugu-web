import { sql, type Kysely } from 'kysely'
import { CoreError } from '../contracts/index.js'
import { databaseTime, uuid } from '../data/codec.js'
import { object, onlyFields, safeInteger } from '../shared/values.js'
import { validateTaskCron } from './cron.js'
import { nextRepeatingFire } from './next-fire.js'
import { scheduleTimestamp } from './normalize-schedule.js'
import { createKyselyScheduledTaskReader, projectScheduledTaskForWeb, type ScheduledTaskListRow } from './task-list.js'
import { desktopScheduleImDeliveryTargets, desktopScheduleImReminderVersion, readDesktopScheduleImTargets, type DesktopScheduleImTarget } from './desktop-im.js'
import { createScheduledTask, updateScheduledTask, type ScheduledTaskCreateInput } from './task-write.js'

const writeFields = ['name', 'payload', 'schedule_kind', 'cron', 'interval_minutes', 'start_at', 'end_at', 'enabled', 'channels', 'execution_mode', 'reminder_lead_minutes']
const notificationChannel = 'web'
const state = (value: boolean) => value ? 1 : 0
const sqliteTime = (value: string | null) => value == null ? null : databaseTime(value, 'sqlite')
const milliseconds = (value: string | null) => value == null ? null : Date.parse(value.replace(' ', 'T') + (/(Z|[+-]\d\d:\d\d)$/.test(value) ? '' : 'Z'))

function validateFields(value: unknown, targets: readonly DesktopScheduleImTarget[]) {
  object(value)
  onlyFields(value, writeFields)
  if ('name' in value && (typeof value.name !== 'string' || !value.name.trim() || [...value.name].length > 100))
    throw new CoreError('invalid_request', '任务名称无效')
  if (typeof value.payload === 'string' && value.payload.length > 4000)
    throw new CoreError('invalid_request', '任务内容过长')
  if ('channels' in value && (!Array.isArray(value.channels) || new Set(value.channels).size !== value.channels.length
    || value.channels.some(channel => channel !== notificationChannel && !targets.some(target => target.platform === channel))
    || targets.some(target => !(value.channels as unknown[]).includes(target.platform))))
    throw new CoreError('invalid_request', '桌面端投递渠道无效')
  if ('reminder_lead_minutes' in value && (!Number.isSafeInteger(value.reminder_lead_minutes) || Number(value.reminder_lead_minutes) < 0 || Number(value.reminder_lead_minutes) > 2880))
    throw new CoreError('invalid_request', '活动提醒提前时间无效')
  return value
}


function desktopScheduleChannelPatch(current: ScheduledTaskListRow, channels: unknown, targets: readonly DesktopScheduleImTarget[]) {
  if (!Array.isArray(channels)) return { channels: current.channels, delivery: current.delivery_targets }
  return { channels: channels.join(','), delivery: targets.length ? desktopScheduleImDeliveryTargets(targets) : null }
}

type DesktopScheduleClaimRow = {
  id: number; name: string; payload: string; channels: string; delivery_targets: string | null
  execution_mode: 'reminder' | 'instruction'; schedule_kind: 'once' | 'cron' | 'interval'; cron: string
  interval_minutes: number | null; start_at: string | null; end_at: string | null
  created_at: string; updated_at: string; last_run_at: string | null
}

function desktopScheduleClaim(row: DesktopScheduleClaimRow, now: number) {
  if (row.execution_mode === 'instruction') return { id: row.id, mode: 'instruction' as const, fireAt: now }
  const channels = row.channels.split(',').filter(Boolean)
  const imTargets = readDesktopScheduleImTargets(row.delivery_targets ? JSON.parse(row.delivery_targets) : null, channels)
  return { id: row.id, mode: 'reminder' as const, name: row.name, payload: row.payload.slice(0, 512),
    ...(imTargets.length ? { imDelivery: { fireAt: now, desktop: channels.includes(notificationChannel),
      version: desktopScheduleImReminderVersion({ name: row.name, payload: row.payload, channels }, imTargets) } } : {}) }
}

export function desktopScheduledTasks<DB>(db: Kysely<DB>, ownerId: string) {
  const owner = uuid(ownerId)
  const key = owner.replaceAll('-', '')
  const read = createKyselyScheduledTaskReader(db, 'sqlite', true)
  async function list(before?: number, eventId: number | null = null) {
    // 活动内容可能包含高开销的 JSON 转义字符，限制单帧的行数。
    const size = 2
    const rows = await read(owner, eventId, undefined, undefined, { before, limit: size + 1 })
    const tasks = rows.slice(0, size).map(row => projectScheduledTaskForWeb(row, false))
    return { tasks, nextBefore: rows.length > size ? tasks.at(-1)!.id : null }
  }
  async function get(id: number, eventId: number | null | 'all' = null) {
    const [row] = await read(owner, eventId, undefined, id)
    if (!row) throw new CoreError('not_found', '定时任务不存在')
    return row
  }
  async function eventReminderPayload(eventId: number) {
    const { rows: [event] } = await sql<{ title: string; date: string; time: string | null }>`
      SELECT title,date,time FROM calendar_events WHERE id=${eventId} AND user_id=${key} AND deleted_at IS NULL`.execute(db)
    if (!event) throw new CoreError('not_found', '活动不存在')
    return `提醒：${event.title}（${event.date}${event.time ? ` ${event.time}` : ''}）`
  }

  return {
    list,
    async assertInstructionCurrent(id: number, task: { name: string; payload: string; channels: string[]; delivery_targets?: unknown }, fireAt?: number) {
      const stamp = fireAt === undefined ? null : sqliteTime(new Date(fireAt).toISOString())
      const { rows } = await sql`SELECT 1 FROM scheduled_tasks WHERE id=${id} AND user_id=${key}
        AND event_id IS NULL AND execution_mode='instruction' AND name=${task.name} AND payload=${task.payload}
        AND channels=${task.channels.join(',')}
        AND json(delivery_targets) IS json(${task.delivery_targets == null ? null : JSON.stringify(task.delivery_targets)})
        AND (end_at IS NULL OR end_at>=${sqliteTime(new Date(fireAt ?? Date.now()).toISOString())})
        AND (${stamp} IS NULL OR last_run_at=${stamp} AND (enabled=1 OR schedule_kind='once'))`.execute(db)
      if (!rows.length) throw new CoreError('conflict', '定时任务已变更、停止或过期')
    },
    async finishInstruction(id: number, fireAt: number, failed: boolean) {
      await sql`UPDATE scheduled_tasks SET last_run_failed=${state(failed)}
        WHERE id=${id} AND user_id=${key} AND execution_mode='instruction'
          AND last_run_at=${sqliteTime(new Date(fireAt).toISOString())}`.execute(db)
    },
    async get(id: number, eventId: number | null | 'all' = null) { return projectScheduledTaskForWeb(await get(id, eventId), false) },
    async create(input: unknown, eventId: number | null = null, targets: readonly DesktopScheduleImTarget[] = []) {
      const body = { ...validateFields(input, targets), event_id: eventId } as unknown as ScheduledTaskCreateInput
      if (eventId !== null) {
        body.execution_mode = 'reminder'
        body.payload = await eventReminderPayload(eventId)
      }
      const result = await createScheduledTask({
        validateCron: validateTaskCron,
        async persist(_owner, values, spec) {
          const now = sqliteTime(new Date().toISOString())
          const { rows: [row] } = await sql<{ id: number }>`INSERT INTO scheduled_tasks
            (user_id,event_id,reminder_lead_minutes,execution_mode,name,payload,cron,schedule_kind,interval_minutes,start_at,end_at,enabled,channels,delivery_targets,created_at,updated_at)
            VALUES (${key},${eventId},${eventId === null ? null : values.reminder_lead_minutes ?? null},${values.execution_mode ?? 'reminder'},${values.name},${values.payload ?? ''},${spec.cron},${spec.schedule_kind},${spec.interval_minutes},
              ${sqliteTime(scheduleTimestamp(spec.start_at))},${sqliteTime(scheduleTimestamp(spec.end_at))},
              ${state(values.enabled !== false)},${Array.isArray(values.channels) ? values.channels.join(',') : notificationChannel},
              ${targets.length ? JSON.stringify(desktopScheduleImDeliveryTargets(targets)) : null},${now},${now}) RETURNING id`.execute(db)
          if (!row) throw new CoreError('storage_error', '创建定时任务失败')
          return { task: await get(row.id, eventId), created: true }
        },
        async publish() {},
      }, owner, body, null, null)
      return projectScheduledTaskForWeb(result.task, false)
    },
    async update(id: number, input: unknown, eventId: number | null = null, targets: readonly DesktopScheduleImTarget[] = []) {
      object(input)
      const currentChannels = Array.isArray(input.channels) && !targets.length ? await get(id, eventId) : null
      const retained = currentChannels
        ? readDesktopScheduleImTargets(currentChannels.delivery_targets, currentChannels.channels.split(',').filter(Boolean))
          .filter(target => (input.channels as unknown[]).includes(target.platform))
        : targets
      const body = validateFields(input, retained)
      const task = await updateScheduledTask({
        validateCron: validateTaskCron,
        async persist(_owner, taskId, patch, prepare) {
          const current = await get(taskId, eventId)
          const { schedule } = await prepare(current, async () => {})
          if (patch.enabled === true && !schedule && current.schedule_kind === 'once' && current.last_run_at)
            throw new CoreError('invalid_request', '请先为已执行的一次性任务设置新的提醒时间')
          const now = sqliteTime(new Date().toISOString())
          const mode = eventId === null ? patch.execution_mode ?? current.execution_mode ?? 'reminder' : 'reminder'
          const reminder = eventId === null ? null : await eventReminderPayload(eventId)
          const payload = reminder ?? patch.payload ?? current.payload
          const enabled = patch.enabled ?? current.enabled
          const { channels, delivery } = desktopScheduleChannelPatch(current, patch.channels, retained)
          const resetFire = Boolean(schedule)
          await sql`UPDATE scheduled_tasks SET reminder_lead_minutes=COALESCE(${eventId === null ? null : patch.reminder_lead_minutes ?? null},reminder_lead_minutes),execution_mode=${mode},name=${patch.name ?? current.name},payload=${payload},
            enabled=${state(enabled === true)},channels=${channels},delivery_targets=${delivery == null ? null : JSON.stringify(delivery)},cron=${schedule ? schedule.cron : current.cron},
            schedule_kind=${schedule ? schedule.schedule_kind : current.schedule_kind},
            interval_minutes=${schedule ? schedule.interval_minutes : current.interval_minutes},
            start_at=${sqliteTime(schedule ? scheduleTimestamp(schedule.start_at) : current.start_at)},
            end_at=${sqliteTime(schedule ? scheduleTimestamp(schedule.end_at) : current.end_at)},
            last_run_at=CASE WHEN ${state(resetFire)}=1 THEN NULL ELSE last_run_at END,
            last_run_failed=CASE WHEN ${state(resetFire)}=1 THEN NULL ELSE last_run_failed END,
            updated_at=${now}
            WHERE id=${taskId} AND user_id=${key} AND event_id IS ${eventId}`.execute(db)
          return get(taskId, eventId)
        },
        async publish() {},
      }, owner, id, body, null)
      return projectScheduledTaskForWeb(task, false)
    },
    async remove(id: number, eventId: number | null = null) {
      await get(id, eventId)
      await sql`DELETE FROM scheduled_tasks WHERE id=${id} AND user_id=${key} AND event_id IS ${eventId}`.execute(db)
      return null
    },
    async claim(now: number, activeInstructions: ReadonlySet<number> = new Set()) {
      const { rows } = await sql<DesktopScheduleClaimRow>`SELECT id,name,payload,channels,delivery_targets,execution_mode,schedule_kind,cron,
          interval_minutes,start_at,end_at,created_at,updated_at,last_run_at FROM scheduled_tasks
          WHERE user_id=${key} AND enabled=1 AND (execution_mode='instruction' OR channels<>'')
          AND (event_id IS NULL OR EXISTS (SELECT 1 FROM calendar_events AS event
            WHERE event.id=scheduled_tasks.event_id AND event.user_id=${key} AND event.deleted_at IS NULL)) ORDER BY id`.execute(db)
      const claimed: ReturnType<typeof desktopScheduleClaim>[] = []
      for (const row of rows) {
        if (row.execution_mode === 'instruction' && activeInstructions.has(row.id)) continue
        const start = milliseconds(row.start_at)
        const end = milliseconds(row.end_at)
        const after = Math.max((milliseconds(row.last_run_at) ?? 0) + 1, milliseconds(row.updated_at) ?? 0, start ?? 0, now - 120_000)
        const due = row.schedule_kind === 'once' ? row.last_run_at == null ? start : null
          : nextRepeatingFire({
            id: String(row.id), kind: row.schedule_kind, cron: row.cron, intervalMinutes: row.interval_minutes,
            startAt: start, createdAt: milliseconds(row.created_at)!, endAt: Math.min(end ?? now, now),
          }, after - 1)
        if (due == null || !Number.isFinite(due) || due > now || (end !== null && now > end)) continue
        await sql`UPDATE scheduled_tasks SET last_run_at=${sqliteTime(new Date(now).toISOString())},last_run_failed=0,
          enabled=CASE WHEN schedule_kind='once' THEN 0 ELSE enabled END
          WHERE id=${row.id} AND user_id=${key}`.execute(db)
        claimed.push(desktopScheduleClaim(row, now))
        if (claimed.length === 12) break
      }
      return claimed
    },
  }
}

export function desktopScheduledTaskId(value: unknown) {
  return safeInteger(value)
}
