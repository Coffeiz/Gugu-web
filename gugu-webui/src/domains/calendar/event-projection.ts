export interface CalendarEventProjectionInput {
  id: number
  title: string
  date: string
  time: string | null
  end_time: string | null
  type: string
  client: string | null
  project_id: number | null
  description: string | null
  version?: number | null
  deleted_at?: string | null
}

export interface CalendarEventRecordProjection extends CalendarEventProjectionInput {
  version: number
  deleted_at: string | null
}

function calendarTimestamp(value: unknown): string | null {
  if (value == null) return null
  return value instanceof Date ? value.toISOString() : String(value)
}

/** 将 PostgreSQL 行映射为日历应用层事件记录。 */
export function calendarEventRecord(
  row: Record<string, unknown>,
  version: number,
): CalendarEventRecordProjection {
  return {
    id: Number(row.id),
    title: String(row.title),
    date: String(row.date),
    time: row.time == null ? null : String(row.time),
    end_time: row.end_time == null ? null : String(row.end_time),
    type: String(row.type),
    client: row.client == null ? null : String(row.client),
    project_id: row.project_id == null ? null : Number(row.project_id),
    description: row.description == null ? null : String(row.description),
    version,
    deleted_at: calendarTimestamp(row.deleted_at),
  }
}

function commonFields(event: CalendarEventProjectionInput) {
  return {
    id: event.id,
    title: event.title,
    date: event.date,
    time: event.time,
    type: event.type,
    client: event.client,
    description: event.description,
  }
}

/** 将事件投影为 API 使用的 camelCase DTO。 */
export function calendarEventResponse(event: CalendarEventProjectionInput) {
  return {
    ...commonFields(event),
    endTime: event.end_time,
    projectId: event.project_id,
    version: Number(event.version || 1),
  }
}

/** 为日历和项目 Undo 生成一致的 calendar_events 快照字段。 */
export function calendarEventSnapshot(
  event: CalendarEventProjectionInput,
  formatDeletedAt: (value: string | null) => string | null = (value) => value,
): Record<string, unknown> {
  return {
    ...commonFields(event),
    end_time: event.end_time,
    project_id: event.project_id,
    version: Number(event.version || 1),
    deleted_at: formatDeletedAt(event.deleted_at ?? null),
  }
}
