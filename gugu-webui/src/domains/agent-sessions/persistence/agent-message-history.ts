import type { Pool } from 'pg'

export class AgentSessionNotFoundError extends Error {
  readonly statusCode = 404
  constructor() {
    super('对话不存在')
  }
}

export interface AgentMessagePageOptions {
  limit?: number
  beforeId?: number
  afterId?: number
  throughId?: number
  runId?: string
}

interface MessageRow {
  id: number
  role: string
  content: string
  is_display_body: boolean
  display_timeline: unknown
  has_display_timeline: boolean
  files: unknown
  conversation_seq: string
  run_id: string | null
  round_id: string | null
  created_at: Date
}

interface CursorRow {
  time_key: string
  conversation_seq: string
}

const timeKey = `COALESCE(
  message.im_platform_sent_ms::numeric,
  message.im_event_received_ms::numeric,
  EXTRACT(EPOCH FROM message.created_at) * 1000
)`

function stripMedia(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripMedia)
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  if (record.type === 'image' || record.type === 'video' || record.type === 'audio') {
    const label = record.type === 'image' ? '图片' : record.type === 'video' ? '视频' : '音频'
    return { type: 'text', text: `[${label}已查看]` }
  }
  if (record.type === 'image_url') {
    const imageUrl = record.image_url
    const url = imageUrl && typeof imageUrl === 'object'
      ? (imageUrl as Record<string, unknown>).url
      : imageUrl
    if (typeof url === 'string' && url.startsWith('data:'))
      return { type: 'text', text: '[图片已查看]' }
  }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, stripMedia(item)]))
}

/** Removes internal provider payloads and media bytes before historical events reach the UI. */
export function projectTimelineEvents(
  messages: Array<{ id: number; displayTimeline: unknown }>,
): unknown[] {
  const events: unknown[] = []
  for (const message of messages) {
    if (!Array.isArray(message.displayTimeline)) continue
    message.displayTimeline.forEach((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
      const item = stripMedia(raw) as Record<string, unknown>
      const event: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(item))
        if (!(item.kind === 'tool' && (key === 'toolInput' || key === 'toolResult'))) event[key] = value
      event.id = `${message.id}:${index}`
      event.messageId = message.id
      event.timelineOrder = item.timelineOrder
      event.createdAt = item.createdAt
      if (item.kind === 'tool' && ('toolInput' in item || 'toolResult' in item)) {
        event.detailsAvailable = true
        event.detailSource = { kind: 'timeline', messageId: message.id, index }
      }
      events.push(event)
    })
  }
  return events
}

export function projectMessageBodies(messages: MessageRow[]) {
  return messages.flatMap((message) => {
    if (!message.is_display_body || (message.has_display_timeline && message.display_timeline !== null))
      return []
    return [{
      id: message.id,
      role: message.role,
      content: message.content,
      files: message.files,
      runId: message.run_id,
      roundId: message.round_id,
      createdAt: message.created_at.toISOString(),
      ...(message.has_display_timeline ? { timelineOmitted: true } : {}),
    }]
  })
}

/**
 * 按 Python display-message store 的排序和游标规则读取消息页。此服务只负责
 * persisted page；timeline 渲染、交互/队列补充和 orphan-run recovery 由后续 Host 集成。
 */
export function createAgentMessageHistory(pool: Pool) {
  return {
    async list(ownerId: string, sessionId: number, options: AgentMessagePageOptions) {
      const owned = await pool.query(
        'SELECT id FROM conversation_sessions WHERE id = $1 AND user_id = $2',
        [sessionId, ownerId],
      )
      if (!owned.rowCount) throw new AgentSessionNotFoundError()

      const limit = Math.min(200, Math.max(1, options.limit ?? 50))
      const params: unknown[] = [sessionId]
      const filters = [
        'message.session_id = $1',
        "message.role <> 'summary'",
        "(message.content_json IS NULL OR (message.display_timeline IS NOT NULL AND message.display_timeline <> 'null'::jsonb))",
      ]
      if (options.runId !== undefined) {
        params.push(options.runId)
        filters.push(`(message.run_id = $${params.length} OR message.display_timeline->0->>'runId' = $${params.length})`)
      }
      const cursorId = options.throughId ?? options.beforeId ?? options.afterId
      const forward = options.afterId !== undefined && options.beforeId === undefined && options.throughId === undefined
      let cursorTime: string | null = null
      let cursorSequence: string | null = null
      if (cursorId !== undefined) {
        const cursor = await pool.query<CursorRow>(
          `SELECT ${timeKey}::text AS time_key, message.conversation_seq::text AS conversation_seq
           FROM conversation_messages AS message WHERE message.id = $1 AND message.session_id = $2`,
          [cursorId, sessionId],
        )
        if (cursor.rows[0]) {
          cursorTime = cursor.rows[0].time_key
          cursorSequence = cursor.rows[0].conversation_seq
          params.push(cursorTime, cursorSequence)
          const comparator = forward ? '>' : '<'
          const cursorParam = params.length - 1
          const sequenceParam = params.length
          filters.push(`(
            ${timeKey} ${comparator} $${cursorParam}::numeric OR
            (${timeKey} = $${cursorParam}::numeric AND message.conversation_seq ${comparator} $${sequenceParam}::bigint)
          )`)
          if (options.throughId !== undefined) {
            params.push(cursorId)
            filters[filters.length - 1] = `(${filters.at(-1)} OR message.id = $${params.length})`
          }
        } else if (options.throughId !== undefined) {
          filters.push('FALSE')
        } else {
          params.push(cursorId)
          filters.push(`message.id ${forward ? '>' : '<'} $${params.length}`)
        }
      }

      const direction = forward ? 'ASC' : 'DESC'
      params.push(limit)
      const fetched = await pool.query<MessageRow>(
        `SELECT message.id, message.role, message.content,
                (message.content_json IS NULL) AS is_display_body,
                CASE WHEN pg_column_size(message.display_timeline) > 1048576 THEN NULL
                     ELSE message.display_timeline END AS display_timeline,
                (message.display_timeline IS NOT NULL AND message.display_timeline <> 'null'::jsonb) AS has_display_timeline,
                message.files, message.conversation_seq::text,
                message.run_id, message.round_id, message.created_at
         FROM conversation_messages AS message
         WHERE ${filters.join(' AND ')}
         ORDER BY ${timeKey} ${direction}, message.conversation_seq ${direction}
         LIMIT $${params.length}`,
        params,
      )
      const messages = forward ? fetched.rows : [...fetched.rows].reverse()
      let hasMore = false
      let hasNewer = false
      if (messages.length) {
        const edge = forward ? messages.at(-1)! : messages[0]!
        const edgeTime = await pool.query<{ time_key: string }>(
          `SELECT ${timeKey}::text AS time_key FROM conversation_messages AS message
           WHERE message.id = $1 AND message.session_id = $2`, [edge.id, sessionId],
        )
        const edgeParams: unknown[] = [sessionId, edgeTime.rows[0]?.time_key, edge.conversation_seq]
        const older = `((${timeKey} < $2::numeric) OR (${timeKey} = $2::numeric AND message.conversation_seq < $3::bigint))`
        const newer = `((${timeKey} > $2::numeric) OR (${timeKey} = $2::numeric AND message.conversation_seq > $3::bigint))`
        const probe = async (predicate: string) => {
          const probeParams = [...edgeParams]
          const probeFilters = [
            'message.session_id = $1',
            "message.role <> 'summary'",
            "(message.content_json IS NULL OR (message.display_timeline IS NOT NULL AND message.display_timeline <> 'null'::jsonb))",
          ]
          if (options.runId !== undefined) {
            probeParams.push(options.runId)
            probeFilters.push(`(message.run_id = $${probeParams.length} OR message.display_timeline->0->>'runId' = $${probeParams.length})`)
          }
          probeFilters.push(predicate)
          const result = await pool.query(
            `SELECT 1 FROM conversation_messages AS message WHERE ${probeFilters.join(' AND ')} LIMIT 1`,
            probeParams,
          )
          return Boolean(result.rowCount)
        }
        hasMore = await probe(older)
        if (forward && messages.length === limit) hasNewer = await probe(newer)
      }
      return {
        messages: projectMessageBodies(messages),
        timelineEvents: projectTimelineEvents(messages.map((message) => ({
          id: message.id,
          displayTimeline: message.display_timeline,
        }))),
        pagination: {
          limit,
          hasMore,
          hasNewer,
          oldestId: messages[0]?.id ?? null,
          newestId: messages.at(-1)?.id ?? null,
        },
      }
    },
  }
}
