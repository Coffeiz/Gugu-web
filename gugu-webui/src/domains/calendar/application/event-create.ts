import { createHash } from 'node:crypto'

export interface CalendarEventCreateInput {
  title: string
  date: string
  time: string | null
  end_time: string | null
  type: string
  client: string | null
  project_id: number | null
  description: string | null
}

export interface CalendarEventRecord extends CalendarEventCreateInput {
  id: number
  version?: number | null
  deleted_at?: string | null
}

export interface CalendarEventResponse {
  id: number
  title: string
  date: string
  time: string | null
  endTime: string | null
  type: string
  client: string | null
  projectId: number | null
  description: string | null
  version: number
}

export interface CalendarEventUndoRecord {
  contextId: string
  resource: 'calendar'
  action: 'create'
  targetRefs: Array<{ kind: 'event'; id: number }>
  beforeState: { items: Record<string, never> }
  afterState: { items: Record<string, Record<string, unknown>> }
  baseVersions: Record<string, { version: 0 }>
}

export interface EventCreateTransaction {
  /** Must scope by owner and key hash. */
  findIdempotent(keyHash: string): Promise<{ fingerprint: string; event: CalendarEventRecord } | null>
  /** Must check ownership and soft deletion in the same transaction. */
  projectExistsForOwner(projectId: number): Promise<boolean>
  /** Must insert inside a DB savepoint and translate only the calendar idempotency unique violation. */
  insertWithSavepoint(
    input: CalendarEventCreateInput,
    idempotency: { keyHash: string; fingerprint: string } | null,
  ): Promise<CalendarEventRecord>
  /** Must persist the Undo row using the same transaction as the event insert. */
  recordUndo(record: CalendarEventUndoRecord): Promise<void>
}

export interface EventCreatePublication {
  ownerId: string
  origin: string | null
  operation: 'create'
  entityId: number
  eventPayload: CalendarEventResponse
}

export interface EventCreateStore {
  /** The callback must commit on success and roll back on rejection. */
  transaction<T>(ownerId: string, work: (tx: EventCreateTransaction) => Promise<T>): Promise<T>
  /** Publish to the calendar event bus only after transaction() has committed. */
  publishCalendarEvent(publication: EventCreatePublication): Promise<void>
}

export interface CreateCalendarEventOptions {
  ownerId: string
  input: unknown
  idempotencyKey?: string | null
  undoContextId?: string | null
  clientId?: string | null
}

export interface CreateCalendarEventResult {
  event: CalendarEventResponse
  created: boolean
}

export class EventCreateError extends Error {
  constructor(readonly statusCode: 400 | 409 | 422, message: string) {
    super(message)
    this.name = 'EventCreateError'
  }
}

/** Raised by a host adapter only after the failed insert savepoint has been rolled back. */
export class CalendarEventIdempotencyUniqueViolation extends Error {
  constructor() {
    super('calendar event idempotency key already exists')
    this.name = 'CalendarEventIdempotencyUniqueViolation'
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readAlias(body: Record<string, unknown>, snake: string, camel: string): unknown {
  return body[snake] === undefined ? body[camel] : body[snake]
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new EventCreateError(422, `${field} 必须是字符串`)
  return value
}

/** Normalize both snake_case and the API's camelCase aliases to Python's model_dump shape. */
export function parseEventCreateInput(value: unknown): CalendarEventCreateInput {
  if (!isObject(value)) throw new EventCreateError(422, '请求内容必须是对象')
  const title = value.title
  const date = value.date
  if (typeof title !== 'string') throw new EventCreateError(422, 'title 必须是字符串')
  if (typeof date !== 'string') throw new EventCreateError(422, 'date 必须是字符串')

  const projectValue = readAlias(value, 'project_id', 'projectId')
  let projectId: number | null = null
  if (projectValue !== undefined && projectValue !== null) {
    const parsedProjectId = typeof projectValue === 'string' && /^[-+]?\d+$/.test(projectValue.trim())
      ? Number(projectValue)
      : typeof projectValue === 'number' ? projectValue : Number.NaN
    if (!Number.isSafeInteger(parsedProjectId))
      throw new EventCreateError(422, 'project_id 必须是整数')
    projectId = parsedProjectId
  }
  const eventType = value.type === undefined ? 'event' : value.type
  if (typeof eventType !== 'string') throw new EventCreateError(422, 'type 必须是字符串')

  return {
    title,
    date,
    time: optionalString(value.time, 'time'),
    end_time: optionalString(readAlias(value, 'end_time', 'endTime'), 'end_time'),
    type: eventType,
    client: optionalString(value.client, 'client'),
    project_id: projectId,
    description: optionalString(value.description, 'description'),
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function calendarEventFingerprint(input: CalendarEventCreateInput): string {
  return digest(canonical(input))
}

function idempotencyValues(key: string | null | undefined, input: CalendarEventCreateInput) {
  if (key == null) return null
  const normalized = String(key).trim()
  if (!normalized || [...normalized].length > 256)
    throw new EventCreateError(422, 'Idempotency-Key 必须为 1 至 256 个字符')
  return { keyHash: digest(normalized), fingerprint: calendarEventFingerprint(input) }
}

function eventResponse(event: CalendarEventRecord): CalendarEventResponse {
  return {
    id: event.id,
    title: event.title,
    date: event.date,
    time: event.time,
    endTime: event.end_time,
    type: event.type,
    client: event.client,
    projectId: event.project_id,
    description: event.description,
    version: Number(event.version || 1),
  }
}

function eventSnapshot(event: CalendarEventRecord): Record<string, unknown> {
  return {
    id: event.id,
    title: event.title,
    date: event.date,
    time: event.time,
    end_time: event.end_time,
    type: event.type,
    client: event.client,
    project_id: event.project_id,
    description: event.description,
    version: Number(event.version || 1),
    deleted_at: event.deleted_at ?? null,
  }
}

function makeUndoRecord(contextId: string, event: CalendarEventRecord): CalendarEventUndoRecord {
  const ref = `event:${event.id}`
  return {
    contextId: contextId.slice(0, 128),
    resource: 'calendar',
    action: 'create',
    targetRefs: [{ kind: 'event', id: event.id }],
    beforeState: { items: {} },
    afterState: { items: { [ref]: eventSnapshot(event) } },
    baseVersions: { [ref]: { version: 0 } },
  }
}

function conflict(): EventCreateError {
  return new EventCreateError(409, '该 Idempotency-Key 已用于不同的创建内容')
}

export async function createCalendarEvent(
  store: EventCreateStore,
  options: CreateCalendarEventOptions,
): Promise<CreateCalendarEventResult> {
  if (!options.ownerId || typeof options.ownerId !== 'string')
    throw new EventCreateError(422, '用户身份无效')
  const input = parseEventCreateInput(options.input)
  const idem = idempotencyValues(options.idempotencyKey, input)

  const result = await store.transaction(options.ownerId, async (tx) => {
    if (idem) {
      const existing = await tx.findIdempotent(idem.keyHash)
      if (existing) {
        if (existing.fingerprint !== idem.fingerprint) throw conflict()
        return { event: eventResponse(existing.event), created: false }
      }
    }
    if (input.project_id !== null && !await tx.projectExistsForOwner(input.project_id))
      throw new EventCreateError(400, '关联的项目不存在')

    let event: CalendarEventRecord
    try {
      event = await tx.insertWithSavepoint(input, idem)
    } catch (error) {
      if (!(error instanceof CalendarEventIdempotencyUniqueViolation) || !idem) throw error
      // Adapter guarantees the insert savepoint is rolled back before this read.
      const winner = await tx.findIdempotent(idem.keyHash)
      if (!winner) throw error
      if (winner.fingerprint !== idem.fingerprint) throw conflict()
      return { event: eventResponse(winner.event), created: false }
    }

    const contextId = options.undoContextId?.trim()
    if (contextId) await tx.recordUndo(makeUndoRecord(contextId, event))
    return { event: eventResponse(event), created: true }
  })

  if (result.created) {
    try {
      await store.publishCalendarEvent({
        ownerId: options.ownerId,
        origin: options.clientId?.trim() || null,
        operation: 'create',
        entityId: result.event.id,
        eventPayload: result.event,
      })
    } catch {
      // The event and Undo are already committed; notification is best-effort.
    }
  }
  return result
}
