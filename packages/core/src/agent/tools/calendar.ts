import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { Transaction } from 'kysely'
import { strip } from '../../shared/values.js'
import { asciiDecimalDigits } from '../../shared/unicode-decimal.js'
import { CoreError, dataContext } from '../../contracts/index.js'
import { createCalendarEvent, EventCreateError, type CalendarEventCreateInput, type EventCreatePublication, type PreparedEventReminder } from '../../calendar/application/event-create.js'
import { updateCalendarEvent, EventUpdateError, type EventUpdatePublication } from '../../calendar/application/event-update.js'
import { createBorrowedCalendarCreateStore } from '../../calendar/create-store.js'
import { calendarReminderBrief, prepareCalendarEventReminder, type CalendarReminderIntent } from '../../calendar/agent-reminders.js'
import type { Database } from '../../data/schema.js'
import type { SqlDataRuntime } from '../../data/runtime.js'
import { createBorrowedKyselyCalendarMutationStores } from '../../calendar/mutation-store.js'
import { deleteCalendarEvents, EventDeleteError } from '../../calendar/application/event-delete.js'
import type { CalendarEventDeletePublication } from '../../calendar/application/event-delete.js'
import { createConfirmationGate, type ConfirmationClaimReference, type ConfirmationTargetSnapshot } from './confirmation.js'
import type { RunIdentity, ToolCall, ToolResult } from '../models.js'
import { agentCalendarEventResponse } from '../../calendar/application/event-read.js'
import type { CalendarAgentReadPort, createAgentCalendarReader } from '../../calendar/application/event-read.js'
import type { CalendarEventProjectionInput } from '../../calendar/event-projection.js'
import type { ToolDefinition, ToolScope } from './contracts.js'

const schema = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  type: z.enum(['event', 'deadline']).optional() }).passthrough()

/** 日历组工具委托共享活动+提醒用例，模型不提供owner或平台投递凭据。 */
export function createListEventsTool(list: ReturnType<typeof createAgentCalendarReader>): ToolDefinition {
  return {
    definition: { name: 'list_events', schema: { type: 'function', function: { name: 'list_events',
      description: '查询日历事件，可按日期范围和类型筛选；from/to 传日期字符串。每个活动都会带 reminders 数组，元素可直接用于 update_event 的完整提醒配置。用户查看日程且结果跨至少 3 个日期并有至少 4 项活动时，首轮答复默认附 Mermaid timeline；单日或少量活动用清单，图表日期和时间必须来自查询结果。',
      parameters: { type: 'object', properties: { from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        type: { type: 'string', enum: ['event', 'deadline'], 'x-empty-string': 'omit' } } } } } },
    effect: 'read', validate(input) { return schema.safeParse(input) },
    async execute(input, scope) {
      const args = input as z.infer<typeof schema>
      const raw = args.limit === undefined ? 50 : args.limit
      const text = typeof raw === 'string' ? asciiDecimalDigits(strip(raw)) : null
      const limit = typeof raw === 'boolean' ? Number(raw) : typeof raw === 'number' ? Math.trunc(raw) : text !== null && /^[+-]?\d(?:_?\d)*$/u.test(text) ? Number(text.replaceAll('_', '')) : NaN
      if (!Number.isSafeInteger(limit)) throw new Error('活动条数无效')
      const value = await list(scope.identity.ownerId, { from: args.from, to: args.to, type: args.type, limit }, scope.signal)
      scope.signal.throwIfAborted()
      return { kind: 'completed', successful: true, mutated: false, value }
    },
  }
}

export interface CalendarReminderTargetPort {
  /** owner与平台聊天位置均由可信身份解析；模型仅表达希望使用的渠道和投递模式。 */
  resolve(identity: RunIdentity, reminders: readonly CalendarReminderIntent[], signal: AbortSignal): Promise<
    | { ok: true; reminders: readonly { channels: readonly string[]; deliveryTargets: unknown; enabled: boolean }[] }
    | { ok: false; error: string }
  >
}
export interface CalendarEventCreateRequest {
  identity: RunIdentity
  roundId: string
  toolCallId: string
  args: { title: string; date: string; all_day: boolean; time?: string; end_time?: string; type?: 'event' | 'deadline'; project_id?: number; reminders?: CalendarReminderIntent[] }
}
export interface CalendarEventCreateToolPort {
  apply(input: CalendarEventCreateRequest & { signal: AbortSignal }): Promise<ToolResult>
  reconcile(input: CalendarEventCreateRequest): Promise<ToolResult>
}

function calendarCreateResponse(result: Awaited<ReturnType<typeof createCalendarEvent>>, replayed = false) {
  return {
    success: true,
    event_id: result.event.id,
    title: result.event.title,
    date: result.event.date,
    time: result.event.time,
    end_time: result.event.endTime,
    reminders: (result.reminders ?? []).map(calendarReminderBrief),
    ...(!result.created || replayed ? { idempotent_replay: true } : {}),
  }
}

/** 事件及内联提醒复用Core创建事务；调用收据和数据库幂等键共同保护提交未知重试。 */
export function createCalendarEventCreatePort(
  core: SqlDataRuntime,
  publish: (event: EventCreatePublication) => Promise<void>,
  reminderTargets: CalendarReminderTargetPort,
  now: () => number = Date.now,
): CalendarEventCreateToolPort {
  if (!core.receipts || typeof publish !== 'function' || typeof reminderTargets?.resolve !== 'function')
    throw new Error('日历事件创建后端未装配')
  const absent = new Error('日历事件创建收据不存在')
  async function reconcile(input: CalendarEventCreateRequest): Promise<ToolResult> {
    try {
      const key = operationCoordinate(input, 'calendar.create'), params = { args: input.args }
      const receipt = await core.operationWithTransaction(key.context, key.operationId, 'agent.calendar.create', params, async () => { throw absent })
      return { kind: 'completed', successful: true, mutated: false, value: { ...receipt.result as Record<string, unknown>, idempotent_replay: true } }
    } catch { return { kind: 'unknown' } }
  }
  return { reconcile, async apply(input) {
    input.signal.throwIfAborted()
    const key = operationCoordinate(input, 'calendar.create'), params = { args: input.args }
    const previous = await reconcile(input)
    if (previous.kind === 'completed') return previous
    const args = input.args
    const event: CalendarEventCreateInput = {
      title: args.title, date: args.date, time: args.all_day ? null : args.time ?? null,
      end_time: args.all_day ? null : args.end_time ?? null, type: args.type ?? 'event',
      client: null, project_id: args.project_id ?? null, description: null,
    }
    let prepared: PreparedEventReminder[] = []
    const requests = args.reminders ?? []
    const requestNow = now()
    if (requests.length) {
      const resolved = await reminderTargets.resolve(input.identity, requests, input.signal)
      input.signal.throwIfAborted()
      if (!resolved.ok) return { kind: 'completed', successful: false, mutated: false, value: { error: resolved.error } }
      if (resolved.reminders.length !== requests.length) return { kind: 'completed', successful: false, mutated: false, value: { error: '活动提醒投递目标解析失败' } }
      try {
        prepared = requests.map((request, index) => prepareCalendarEventReminder(event, request, resolved.reminders[index]!, requestNow))
      } catch (error) {
        if (error instanceof EventCreateError) return { kind: 'completed', successful: false, mutated: false, value: { error: error.message } }
        return { kind: 'completed', successful: false, mutated: false, value: { error: '活动提醒配置无效' } }
      }
    }
    const publications: EventCreatePublication[] = []
    try {
      const receipt = await core.operationWithTransaction(key.context, key.operationId, 'agent.calendar.create', params, async tx => {
        const store = createBorrowedCalendarCreateStore(tx, core.backend)
        const borrowed = { ...store, async publishCalendarEvent(event: EventCreatePublication) { publications.push(event) } }
        const created = await createCalendarEvent(borrowed, {
          ownerId: input.identity.ownerId,
          input: event,
          undoContextId: input.identity.sessionId,
          idempotencyKey: key.operationId,
          idempotencyPayload: args,
          reminders: prepared,
          now: requestNow,
        })
        return calendarCreateResponse(created)
      }, { signal: input.signal })
      if (!receipt.replayed) for (const publication of publications) { try { await publish(publication) } catch { /* 提交后通知失败不回滚。 */ } }
      return { kind: 'completed', successful: true, mutated: !receipt.replayed, value: receipt.replayed
        ? { ...receipt.result as Record<string, unknown>, idempotent_replay: true } : receipt.result }
    } catch (error) {
      if (error instanceof CoreError && error.code === 'conflict') return { kind: 'completed', successful: false, mutated: false, value: { error: '该 Idempotency-Key 已用于不同的创建内容' } }
      if (error instanceof EventCreateError) return { kind: 'completed', successful: false, mutated: false,
        value: { error: error.statusCode === 400 && error.message === '关联的项目不存在' ? '项目不存在' : error.message } }
      return reconcile(input)
    }
  } }
}

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/u
const eventReminderSchema = z.object({
  lead_minutes: z.number().int().safe().min(0),
  channels: z.array(z.enum(['web', 'feishu', 'qq', 'wechat'])).min(1).optional(),
  delivery_mode: z.enum(['owner_private', 'current_group']).optional(),
  enabled: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  if (value.channels && new Set(value.channels).size !== value.channels.length)
    context.addIssue({ code: 'custom', message: 'channels 不能重复' })
})
const calendarCreateSchema = z.object({
  title: z.string(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u), time: z.string().regex(timePattern).optional(),
  end_time: z.string().regex(timePattern).optional(), type: z.enum(['event', 'deadline']).optional(),
  project_id: z.number().int().safe().optional(), reminders: z.array(eventReminderSchema).max(20).optional(), all_day: z.boolean(),
}).passthrough().superRefine((value, context) => {
  if (value.all_day && (value.time !== undefined || value.end_time !== undefined)) context.addIssue({ code: 'custom', message: '全天活动不能设置开始或结束时间' })
  if (!value.all_day && value.time === undefined) context.addIssue({ code: 'custom', message: '非全天活动必须提供 time' })
})

export function createCalendarEventCreateTool(port: CalendarEventCreateToolPort): ToolDefinition {
  const request = (args: z.infer<typeof calendarCreateSchema>, identity: RunIdentity, roundId: string, toolCallId: string): CalendarEventCreateRequest => ({ identity, roundId, toolCallId, args })
  return {
    definition: { name: 'create_event', schema: { type: 'function', function: { name: 'create_event',
      description: '创建日历活动或截止提醒；全天活动传 all_day=true，定时活动需提供 time；可在提醒数组中设置提前分钟数和通知渠道。',
      parameters: { type: 'object', properties: {
        title: { type: 'string' }, date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        time: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' }, end_time: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
        type: { type: 'string', enum: ['event', 'deadline'] }, project_id: { type: 'integer' }, all_day: { type: 'boolean' },
        reminders: { type: 'array', maxItems: 20, 'x-empty-string': 'empty-array', items: { type: 'object', properties: {
          lead_minutes: { type: 'integer', minimum: 0 }, channels: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: ['web', 'feishu', 'qq', 'wechat'] } },
          delivery_mode: { type: 'string', enum: ['owner_private', 'current_group'] }, enabled: { type: 'boolean' },
        }, required: ['lead_minutes'], additionalProperties: false } },
      }, required: ['title', 'date', 'all_day'], allOf: [
        { if: { required: ['all_day'], properties: { all_day: { const: true } } }, then: { not: { anyOf: [{ required: ['time'] }, { required: ['end_time'] }] } } },
        { if: { required: ['all_day'], properties: { all_day: { const: false } } }, then: { required: ['time'] } },
      ] } } } },
    effect: 'write', validate: input => calendarCreateSchema.safeParse(input),
    execute(input, scope, call) { return port.apply({ ...request(input as z.infer<typeof calendarCreateSchema>, scope.identity, scope.roundId, call.id), signal: scope.signal }) },
    reconcile(input, identity, call) { return port.reconcile(request(input as z.infer<typeof calendarCreateSchema>, identity, identity.roundId, call.id)) },
  }
}

export interface CalendarEventUpdateTargetPort extends Pick<CalendarAgentReadPort, 'getById' | 'findByTitle'> {}
export interface CalendarEventUpdateRequest {
  identity: RunIdentity
  roundId: string
  toolCallId: string
  args: { event_id?: number; event?: string; on_date?: string; title?: string; date?: string; all_day?: boolean; time?: string; end_time?: string; type?: 'event' | 'deadline'; project_id?: number; description?: string; reminders?: CalendarReminderIntent[] }
}
export interface CalendarEventUpdateToolPort {
  apply(input: CalendarEventUpdateRequest & { signal: AbortSignal }): Promise<ToolResult>
  reconcile(input: CalendarEventUpdateRequest): Promise<ToolResult>
}

function resolveCalendarUpdateTarget(port: CalendarEventUpdateTargetPort, input: CalendarEventUpdateRequest, signal: AbortSignal) {
  return (async (): Promise<{ event?: CalendarEventProjectionInput; error?: string; candidates?: Array<{ id: number; title: string; date: string }> }> => {
    const { event_id: eventId, event: title, on_date: onDate } = input.args
    if (eventId) {
      const event = await port.getById?.(input.identity.ownerId, eventId, signal)
      return event ? { event } : { error: '事件不存在' }
    }
    if (title) {
      const query = title.trim()
      const matches = await port.findByTitle?.(input.identity.ownerId, query, signal) ?? []
      const rows = onDate ? matches.filter(event => event.date === onDate) : matches
      if (!rows.length) return { error: `未找到事件「${query}」` }
      if (rows.length > 1) return { error: `有多个匹配「${query}」的事件，请加 on_date 指明日期或用 event_id`,
        candidates: rows.slice(0, 10).map(event => ({ id: event.id, title: event.title, date: event.date })) }
      return { event: rows[0] }
    }
    return { error: '需提供 event_id 或事件标题 event' }
  })()
}

/** Agent更新复用日历 CAS/提醒同步用例；解析和投递身份由可信Core端口提供。 */
export function createCalendarEventUpdatePort(
  core: SqlDataRuntime,
  publish: (event: EventUpdatePublication) => Promise<void>,
  targets: CalendarEventUpdateTargetPort,
  reminderTargets: CalendarReminderTargetPort,
  now: () => number = Date.now,
): CalendarEventUpdateToolPort {
  if (!core.receipts || typeof publish !== 'function' || typeof targets?.getById !== 'function'
    || typeof targets?.findByTitle !== 'function' || typeof reminderTargets?.resolve !== 'function')
    throw new Error('日历事件更新后端未装配')
  const absent = new Error('日历事件更新收据不存在')
  async function reconcile(input: CalendarEventUpdateRequest): Promise<ToolResult> {
    try {
      const key = operationCoordinate(input, 'calendar.update'), params = { args: input.args }
      const receipt = await core.operationWithTransaction(key.context, key.operationId, 'agent.calendar.update', params, async () => { throw absent })
      return { kind: 'completed', successful: true, mutated: false, value: { ...receipt.result as Record<string, unknown>, idempotent_replay: true } }
    } catch { return { kind: 'unknown' } }
  }
  return { reconcile, async apply(input) {
    input.signal.throwIfAborted()
    const key = operationCoordinate(input, 'calendar.update'), params = { args: input.args }
    const previous = await reconcile(input)
    if (previous.kind === 'completed') return previous
    const target = await resolveCalendarUpdateTarget(targets, input, input.signal)
    input.signal.throwIfAborted()
    if (!target.event) return { kind: 'completed', successful: false, mutated: false,
      value: { error: target.error ?? '事件不存在', ...(target.candidates ? { candidates: target.candidates } : {}) } }
    const args = input.args
    const fields = ['title', 'date', 'time', 'end_time', 'type', 'project_id', 'description', 'reminders'] as const
    if (args.all_day === false && args.time === undefined)
      return { kind: 'completed', successful: false, mutated: false, value: { error: 'all_day=false 时必须提供 time' } }
    const updates: Record<string, unknown> = {}
    for (const field of fields) if (args[field] !== undefined && field !== 'reminders') updates[field] = args[field]
    if (args.all_day === true) { updates.time = null; updates.end_time = null }
    if (!Object.keys(updates).length && args.reminders === undefined)
      return { kind: 'completed', successful: false, mutated: false,
        value: { error: '没提供要修改的字段（title/date/time/end_time/type/project_id/description/reminders），未改动。' } }

    let prepared: PreparedEventReminder[] | undefined
    if (args.reminders !== undefined) {
      const resolved = await reminderTargets.resolve(input.identity, args.reminders, input.signal)
      input.signal.throwIfAborted()
      if (!resolved.ok) return { kind: 'completed', successful: false, mutated: false, value: { error: resolved.error } }
      if (resolved.reminders.length !== args.reminders.length)
        return { kind: 'completed', successful: false, mutated: false, value: { error: '活动提醒投递目标解析失败' } }
      const updatedEvent: CalendarEventCreateInput = {
        title: String(updates.title ?? target.event.title), date: String(updates.date ?? target.event.date),
        time: updates.time === null ? null : typeof updates.time === 'string' ? updates.time : target.event.time,
        end_time: updates.end_time === null ? null : typeof updates.end_time === 'string' ? updates.end_time : target.event.end_time,
        type: String(updates.type ?? target.event.type), client: target.event.client, project_id: updates.project_id === undefined ? target.event.project_id : updates.project_id as number | null,
        description: updates.description === undefined ? target.event.description : updates.description as string | null,
      }
      try {
        const requestNow = now()
        prepared = args.reminders.map((request, index) => prepareCalendarEventReminder(updatedEvent, request, resolved.reminders[index]!, requestNow))
      } catch (error) {
        if (error instanceof EventCreateError) return { kind: 'completed', successful: false, mutated: false, value: { error: error.message } }
        return { kind: 'completed', successful: false, mutated: false, value: { error: '活动提醒配置无效' } }
      }
    }

    const publications: EventUpdatePublication[] = []
    try {
      const receipt = await core.operationWithTransaction(key.context, key.operationId, 'agent.calendar.update', params, async tx => {
        const borrowed = createBorrowedKyselyCalendarMutationStores(tx, core.backend)
        const store = { ...borrowed.update, async publishCalendarEvent(event: EventUpdatePublication) { publications.push(event) } }
        const event = await updateCalendarEvent(store, {
          ownerId: input.identity.ownerId, eventId: target.event!.id,
          body: { ...updates, version: Number(target.event!.version ?? 1) }, undoContextId: input.identity.sessionId,
          reminders: prepared,
        })
        const tasks = await borrowed.update.transaction(input.identity.ownerId, current => current.listOwnedEventReminders(target.event!.id))
        const response = agentCalendarEventResponse({ ...target.event!, ...event, end_time: event.endTime }, tasks)
        return { success: true, event_id: event.id, reminders: response.reminders }
      }, { signal: input.signal })
      if (!receipt.replayed) for (const publication of publications) { try { await publish(publication) } catch { /* 提交后通知失败不回滚。 */ } }
      return { kind: 'completed', successful: true, mutated: !receipt.replayed,
        value: receipt.replayed ? { ...receipt.result as Record<string, unknown>, idempotent_replay: true } : receipt.result }
    } catch (error) {
      if (error instanceof CoreError && error.code === 'conflict') return { kind: 'completed', successful: false, mutated: false,
        value: { error: '该 Idempotency-Key 已用于不同的更新内容' } }
      if (error instanceof EventUpdateError) return { kind: 'completed', successful: false, mutated: false, value: { error: error.message } }
      return reconcile(input)
    }
  } }
}

const eventUpdateSchema = z.object({
  event_id: z.number().int().safe().optional(), event: z.string().optional(), on_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
  title: z.string().optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
  time: z.string().regex(timePattern).optional(), end_time: z.string().regex(timePattern).optional(),
  type: z.enum(['event', 'deadline']).optional(), project_id: z.number().int().safe().optional(), description: z.string().optional(),
  all_day: z.boolean().optional(), reminders: z.union([z.array(eventReminderSchema).max(20), z.literal('')]).optional()
    .transform(value => value === '' ? [] : value),
}).passthrough().superRefine((value, context) => {
  if (value.event_id === undefined && value.event === undefined) context.addIssue({ code: 'custom', message: '需提供 event_id 或事件标题 event' })
  if (value.all_day === true && (value.time !== undefined || value.end_time !== undefined)) context.addIssue({ code: 'custom', message: '全天活动不能设置开始或结束时间' })
  if (value.all_day === false && value.time === undefined) context.addIssue({ code: 'custom', message: 'all_day=false 时必须提供 time' })
})

export function createCalendarEventUpdateTool(port: CalendarEventUpdateToolPort): ToolDefinition {
  const request = (args: z.infer<typeof eventUpdateSchema>, identity: RunIdentity, roundId: string, toolCallId: string): CalendarEventUpdateRequest => ({ identity, roundId, toolCallId, args })
  return {
    definition: { name: 'update_event', schema: { type: 'function', function: { name: 'update_event',
      description: '修改日历事件及其提醒；按 event_id 或标题 event（可附 on_date）定位。reminders 省略表示不改，提供数组表示整体替换，空数组清除提醒。',
      parameters: { type: 'object', properties: {
        event_id: { type: 'integer' }, event: { type: 'string' }, on_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        title: { type: 'string' }, date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        time: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' }, end_time: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
        type: { type: 'string', enum: ['event', 'deadline'] }, project_id: { type: 'integer' }, description: { type: 'string' }, all_day: { type: 'boolean' },
        reminders: { type: 'array', maxItems: 20, 'x-empty-string': 'empty-array', items: { type: 'object', properties: {
          lead_minutes: { type: 'integer', minimum: 0 }, channels: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: ['web', 'feishu', 'qq', 'wechat'] } },
          delivery_mode: { type: 'string', enum: ['owner_private', 'current_group'] }, enabled: { type: 'boolean' },
        }, required: ['lead_minutes'], additionalProperties: false } },
      }, required: [], anyOf: [{ required: ['event_id'] }, { required: ['event'] }], allOf: [
        { if: { required: ['all_day'], properties: { all_day: { const: true } } }, then: { not: { anyOf: [{ required: ['time'] }, { required: ['end_time'] }] } } },
        { if: { required: ['all_day'], properties: { all_day: { const: false } } }, then: { required: ['time'] } },
      ] } } } },
    effect: 'write', validate: input => eventUpdateSchema.safeParse(input),
    execute(input, scope, call) { return port.apply({ ...request(input as z.infer<typeof eventUpdateSchema>, scope.identity, scope.roundId, call.id), signal: scope.signal }) },
    reconcile(input, identity, call) { return port.reconcile(request(input as z.infer<typeof eventUpdateSchema>, identity, identity.roundId, call.id)) },
  }
}

export interface CalendarDeleteConfirmationPort {
  gate: ReturnType<typeof createConfirmationGate>
  /** 必须在事件写入和操作收据所在的同一事务中核验目标并单次 claim。 */
  claim(tx: Transaction<Database>, reference: ConfirmationClaimReference, signal: AbortSignal): Promise<boolean>
}

export interface CalendarDeleteRequest {
  identity: RunIdentity
  roundId: string
  toolCallId: string
  args: { event_id?: number; event_ids?: number[]; event?: string; on_date?: string }
}

export interface CalendarDeletePort {
  confirmation?: CalendarDeleteConfirmationPort
  apply(input: CalendarDeleteRequest & { signal: AbortSignal; call: ToolCall; scope: ToolScope }): Promise<ToolResult>
  reconcile(input: CalendarDeleteRequest): Promise<ToolResult>
}

type DeleteTarget = {
  ids: number[]
  versions: Map<number, number>
  titles: string[]
  reminders: number[]
  snapshot: ConfirmationTargetSnapshot
  error?: string
  candidates?: Array<{ id: number; title: string; date: string }>
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex') }
function operationCoordinate(input: { identity: RunIdentity; roundId: string; toolCallId: string }, namespace = 'calendar.delete') {
  const context = dataContext(input.identity.ownerId)
  const parts = [namespace, context.ownerId, input.identity.sessionId, input.identity.runId, input.roundId, input.toolCallId]
  if (parts.some(value => typeof value !== 'string' || !value.trim())) throw new CoreError('invalid_request', '工具运行身份无效')
  const hex = createHash('sha256').update(JSON.stringify(parts)).digest('hex')
  const raw = hex.slice(0, 12) + '5' + hex.slice(13, 16) + '8' + hex.slice(17, 32)
  return { context, operationId: `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}` }
}
function ownerKey(core: Pick<SqlDataRuntime, 'backend'>, rawOwner: string) {
  const owner = dataContext(rawOwner).ownerId
  return core.backend === 'sqlite' ? owner.replaceAll('-', '') : owner
}

async function resolveCalendarDeleteTarget(core: Pick<SqlDataRuntime, 'db' | 'backend'>, rawOwner: string, args: CalendarDeleteRequest['args'], signal: AbortSignal): Promise<DeleteTarget> {
  const owner = ownerKey(core, rawOwner)
  const submitted = args.event_ids ?? (args.event_id !== undefined ? [args.event_id] : null)
  let ids: number[]
  if (submitted !== null) {
    if (args.event_ids !== undefined && (!Array.isArray(args.event_ids) || args.event_ids.length < 1 || args.event_ids.length > 50))
      return { ids: [], versions: new Map(), titles: [], reminders: [], snapshot: { targetsDigest: '', versionsDigest: '' }, error: 'event_ids 必须是 1-50 个事件 id' }
    const rows = await core.db.selectFrom('calendar_events').select(['id', 'title', 'version'])
      .where('user_id', '=', owner).where('deleted_at', 'is', null).where('id', 'in', submitted).execute()
    signal.throwIfAborted()
    const byId = new Map(rows.map(row => [Number(row.id), row]))
    for (const id of submitted) if (!byId.has(id))
      return { ids: [], versions: new Map(), titles: [], reminders: [], snapshot: { targetsDigest: '', versionsDigest: '' }, error: '事件不存在' }
    ids = [...submitted].sort((a, b) => a - b)
  } else {
    if (typeof args.event !== 'string' || !args.event.trim())
      return { ids: [], versions: new Map(), titles: [], reminders: [], snapshot: { targetsDigest: '', versionsDigest: '' }, error: '需提供 event_id 或事件标题 event' }
    const title = args.event.trim()
    const rows = await core.db.selectFrom('calendar_events').select(['id', 'title', 'date'])
      .where('user_id', '=', owner).where('deleted_at', 'is', null).orderBy('id').execute()
    signal.throwIfAborted()
    const exact = rows.filter(row => row.title === title)
    const matched = exact.length ? exact : rows.filter(row => String(row.title).toLocaleLowerCase().includes(title.toLocaleLowerCase()))
    const dated = args.on_date ? matched.filter(row => row.date === args.on_date) : matched
    if (!dated.length) return { ids: [], versions: new Map(), titles: [], reminders: [], snapshot: { targetsDigest: '', versionsDigest: '' }, error: `未找到事件「${title}」` }
    if (dated.length > 1) return { ids: [], versions: new Map(), titles: [], reminders: [], snapshot: { targetsDigest: '', versionsDigest: '' },
      error: `有多个匹配「${title}」的事件，请加 on_date 指明日期或用 event_id`,
      candidates: dated.slice(0, 10).map(row => ({ id: Number(row.id), title: row.title, date: row.date })) }
    ids = [Number(dated[0]!.id)]
  }
  const events = await core.db.selectFrom('calendar_events').select(['id', 'title', 'date', 'time', 'end_time', 'type', 'contact_name', 'project_id', 'description', 'version', 'deleted_at'])
    .where('user_id', '=', owner).where('deleted_at', 'is', null).where('id', 'in', ids).orderBy('id').execute()
  signal.throwIfAborted()
  if (events.length !== ids.length) return { ids: [], versions: new Map(), titles: [], reminders: [], snapshot: { targetsDigest: '', versionsDigest: '' }, error: '事件不存在' }
  const tasks = await core.db.selectFrom('scheduled_tasks').select(['id', 'event_id', 'enabled', 'name', 'payload', 'cron', 'schedule_kind', 'start_at', 'reminder_lead_minutes', 'channels', 'delivery_targets'])
    .where('user_id', '=', owner).where('event_id', 'in', ids).orderBy('id').execute()
  signal.throwIfAborted()
  const reminderIds = tasks.map(task => Number(task.id))
  const snapshot = {
    targetIds: { eventIds: ids, reminderIds },
    targetsDigest: digest({ eventIds: ids, reminderIds }),
    versionsDigest: digest({ events: events.map(event => ({ ...event, id: Number(event.id), version: Number(event.version) })),
      reminders: tasks.map(task => ({ ...task, id: Number(task.id), event_id: Number(task.event_id), start_at: task.start_at instanceof Date ? task.start_at.toISOString() : task.start_at,
        delivery_targets: typeof task.delivery_targets === 'string' ? JSON.parse(task.delivery_targets) : task.delivery_targets })) }),
  }
  return { ids, versions: new Map(events.map(event => [Number(event.id), Number(event.version)])), titles: events.map(event => event.title), reminders: reminderIds, snapshot }
}

/** 复用日历软删服务；确认目标固定到事件及提醒快照，claim 与操作收据同事务。 */
export function createCalendarDeletePort(
  core: SqlDataRuntime,
  publish: (publication: CalendarEventDeletePublication) => Promise<void>,
  confirmation?: CalendarDeleteConfirmationPort,
): CalendarDeletePort {
  if (!core.receipts || typeof publish !== 'function') throw new Error('日历删除后端未装配')
  const absent = new Error('日历删除收据不存在')
  async function reconcile(input: CalendarDeleteRequest): Promise<ToolResult> {
    try {
      const key = operationCoordinate(input)
      const params = { args: input.args }
      const receipt = await core.operationWithTransaction(key.context, key.operationId, 'agent.calendar.delete', params, async () => { throw absent })
      return { kind: 'completed', successful: true, mutated: false, value: receipt.result }
    } catch { return { kind: 'unknown' } }
  }
  return { confirmation, reconcile, async apply(input) {
    input.signal.throwIfAborted()
    if (input.scope.resolution?.status === 'confirmed') {
      const previous = await reconcile({ identity: input.identity, roundId: input.roundId, toolCallId: input.toolCallId, args: input.args })
      if (previous.kind === 'completed') return previous
    }
    const isBatch = input.args.event_ids !== undefined
    if (isBatch && (!input.args.event_ids!.length || input.args.event_ids!.length > 50))
      return { kind: 'completed', successful: false, mutated: false, value: { error: 'event_ids 必须是 1-50 个事件 id' } }
    const targets = await resolveCalendarDeleteTarget(core, input.identity.ownerId, input.args, input.signal)
    input.signal.throwIfAborted()
    if (targets.error) return { kind: 'completed', successful: false, mutated: false, value: { error: targets.error, ...(targets.candidates ? { candidates: targets.candidates } : {}) } }
    if (!confirmation) return { kind: 'completed', successful: false, mutated: false, value: { error: '日历事件删除需要可信确认能力' } }
    const params = { args: input.args }, inputDigest = digest(params)
    if (input.scope.resolution === null) {
      const prepared = await confirmation.gate.prepare(input.call, input.scope, inputDigest, targets.snapshot)
      return prepared.ok ? { kind: 'waiting', interaction: prepared.value }
        : { kind: 'completed', successful: false, mutated: false, value: { error: '日历事件删除确认无效或已过期' } }
    }
    const verified = await confirmation.gate.verify(input.call, input.scope, inputDigest, targets.snapshot)
    if (!verified.ok) return { kind: 'completed', successful: false, mutated: false, value: { error: '日历事件删除确认无效或已过期' } }
    const key = operationCoordinate(input)
    const publications: CalendarEventDeletePublication[] = []
    let callbackError: unknown
    try {
      const receipt = await core.operationWithTransaction(key.context, key.operationId, 'agent.calendar.delete', params, async tx => {
        try {
          input.signal.throwIfAborted()
          if (!await confirmation.claim(tx, verified.value, input.signal)) throw new Error('日历事件删除确认已使用或目标已变化')
          const current = await resolveCalendarDeleteTarget({ db: tx, backend: core.backend }, input.identity.ownerId, { event_ids: targets.ids }, input.signal)
          if (current.error || current.snapshot.targetsDigest !== targets.snapshot.targetsDigest || current.snapshot.versionsDigest !== targets.snapshot.versionsDigest)
            throw new Error('日历事件删除确认已使用或目标已变化')
          const stores = createBorrowedKyselyCalendarMutationStores(tx, core.backend)
          const deleteStore = { ...stores.delete, async publishResourceChanged(event: CalendarEventDeletePublication) { publications.push(event) } }
          const results = await deleteCalendarEvents(deleteStore, { ownerId: input.identity.ownerId, eventIds: targets.ids,
            expectedVersions: targets.versions, undoContextId: input.identity.sessionId, clientId: null })
          input.signal.throwIfAborted()
          return isBatch
            ? { success: true, deleted_count: results.length, results: results.map(result => ({ deleted_event_id: result.eventId, title: result.title, deleted_reminders: result.deletedReminders })) }
            : { success: true, deleted_event_id: results[0]!.eventId, title: results[0]!.title, deleted_reminders: results[0]!.deletedReminders }
        } catch (error) { callbackError = error; throw error }
      }, { signal: input.signal })
      if (!receipt.replayed) for (const publication of publications) { try { await publish(publication) } catch { /* 提交后通知失败不回滚。 */ } }
      return { kind: 'completed', successful: true, mutated: !receipt.replayed, value: receipt.result }
    } catch (error) {
      if (error instanceof CoreError && error.code === 'conflict') return { kind: 'completed', successful: false, mutated: false, value: { error: '操作标识已用于不同内容' } }
      if (input.signal.aborted && error === callbackError) throw error
      if (error === callbackError && error instanceof EventDeleteError) return { kind: 'completed', successful: false, mutated: false, value: { error: error.message } }
      if (error === callbackError && error instanceof Error) return { kind: 'completed', successful: false, mutated: false, value: { error: error.message } }
      return reconcile({ ...input, args: input.args })
    }
  } }
}

export function createCalendarDeleteTool(port: CalendarDeletePort): ToolDefinition {
  const id = z.number().int().safe()
  const schema = z.object({ event_id: id.optional(), event_ids: z.array(id).max(50).optional(), event: z.string().optional(), on_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional() })
    .refine(value => value.event_ids === undefined || new Set(value.event_ids).size === value.event_ids.length)
  const request = (args: z.infer<typeof schema>, identity: RunIdentity, roundId: string, toolCallId: string): CalendarDeleteRequest => ({ identity, roundId, toolCallId, args })
  return {
    definition: { name: 'delete_event', schema: { type: 'function', function: { name: 'delete_event', description: '软删除一个或多个日历事件及其提醒；执行前需确认，可在当前对话撤销。单项支持 event_id 或事件标题 event，批量传 event_ids。',
      parameters: { type: 'object', properties: { event_id: { type: 'integer' }, event_ids: { type: 'array', maxItems: 50, uniqueItems: true, items: { type: 'integer' } }, event: { type: 'string' }, on_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } } } } } },
    effect: 'write', requiresInteraction: true, confirmationReplay: true, validate: input => schema.safeParse(input),
    execute(input, scope, call) { return port.apply({ ...request(input as z.infer<typeof schema>, scope.identity, scope.roundId, call.id), signal: scope.signal, call, scope }) },
    reconcile(input, identity, call) { return port.reconcile(request(input as z.infer<typeof schema>, identity, identity.roundId, call.id)) },
  }
}
