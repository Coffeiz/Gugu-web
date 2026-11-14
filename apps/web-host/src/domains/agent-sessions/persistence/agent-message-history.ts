import type { Pool } from 'pg'
import type { AgentInteractionHistoryWindow } from './agent-interaction-history.js'
import { loadGroupMentionNames, replacePlatformMentionIds } from './agent-group-mentions.js'
import { sanitizeMediaPayload } from '../media-payload.js'

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
  restoreInteractions?: boolean
}

export interface AgentMessageHistoryRuntime {
  activeStatuses?(sessionIds: number[]): Promise<Map<number, boolean>>
  filesystemAuthorizationEnabled?(): boolean
  workspaceShellSupported?(): boolean
  recoverOrphanedSession?(ownerId: string, sessionId: number): Promise<boolean>
  listInteractions?(
    ownerId: string,
    sessionId: number,
    window: AgentInteractionHistoryWindow,
  ): Promise<unknown[]>
  nowSeconds?(): number
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
  created_at: Date | string
  client_message_id?: string | null
  quoted_text?: string | null
  references_json?: unknown
  platform_user_id?: string | null
  platform_user_name?: string | null
  platform_bot_user_id?: string | null
  run_outcome?: unknown
  im_platform_sent_ms?: number | string | null
  im_event_received_ms?: number | string | null
  time_key?: string
}

interface SessionRow {
  id: number
  source: string | null
  title: string | null
  chat_type: string | null
  workspace_name: string | null
  session_context: unknown
  execution_state: string | null
  pending_message_count: number | null
  bot_id: string | null
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

function addOneMicrosecondMs(value: string): string {
  const [whole = '0', fraction = ''] = value.split('.')
  const units = BigInt(whole) * 1000n + BigInt((fraction + '000').slice(0, 3)) + 1n
  return `${units / 1000n}.${String(units % 1000n).padStart(3, '0')}`
}

function messageTimeMs(message: MessageRow): string {
  const platformSentAt = Number(message.im_platform_sent_ms)
  if (platformSentAt > 0) return String(platformSentAt)
  const receivedAt = Number(message.im_event_received_ms)
  if (receivedAt > 0) return String(receivedAt)
  return message.time_key ?? String(new Date(message.created_at).getTime())
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
      const item = sanitizeMediaPayload(raw) as Record<string, unknown>
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

function normalizeQqAttachmentPlaceholders(text: string, files: unknown, quoted = false): string {
  if (!text || !Array.isArray(files) || files.length === 0) return text
  let changed = false
  const normalized = text.replace(
    /<attachmentType="([A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+)",attachmentIndex=(\d+),description="[^"]*">/g,
    (placeholder, expectedMime: string, rawIndex: string) => {
      const index = Number(rawIndex)
      if (!Number.isSafeInteger(index) || index >= files.length) return placeholder
      const attachment = files[index]
      if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) return placeholder
      const record = attachment as Record<string, unknown>
      if (record.quoted !== quoted) return placeholder
      const rawMime = record.content_type || record.mime || record.type || ''
      const actualMime = String(rawMime).split(';', 1)[0]!.trim().toLowerCase()
      if (actualMime !== expectedMime.toLowerCase()) return placeholder
      changed = true
      return ''
    },
  )
  return changed ? normalized.trim() : text
}

export function projectMessageBodies(messages: MessageRow[], source?: string) {
  return projectMessageBodiesWithMentions(messages, source, new Map())
}

export function projectMessageBodiesWithMentions(
  messages: MessageRow[],
  source: string | undefined,
  mentionNames: ReadonlyMap<string, string>,
) {
  return messages.flatMap((message) => {
    if (!message.is_display_body || (message.has_display_timeline && message.display_timeline !== null))
      return []
    const files = message.files ?? []
    const normalizedContent = typeof message.content === 'string' && source === 'qq'
      ? normalizeQqAttachmentPlaceholders(message.content, files)
      : message.content
    const normalizedQuotedText = typeof message.quoted_text === 'string' && source === 'qq'
      ? normalizeQqAttachmentPlaceholders(message.quoted_text, files, true)
      : message.quoted_text ?? null
    const content = typeof normalizedContent === 'string'
      ? replacePlatformMentionIds(normalizedContent, mentionNames) ?? normalizedContent
      : normalizedContent
    const quotedText = typeof normalizedQuotedText === 'string'
      ? replacePlatformMentionIds(normalizedQuotedText, mentionNames)
      : normalizedQuotedText
    const platformSentAt = Number(message.im_platform_sent_ms)
    const eventReceivedAt = Number(message.im_event_received_ms)
    const occurredAt = platformSentAt > 0
      ? new Date(platformSentAt).toISOString()
      : eventReceivedAt > 0
        ? new Date(eventReceivedAt).toISOString()
        : new Date(message.created_at).toISOString()
    return [{
      id: message.id,
      role: message.role,
      clientMessageId: message.client_message_id ?? null,
      timelineOrder: message.id * 1_000_000,
      content,
      files,
      references: message.references_json ?? [],
      quotedText,
      platformUserId: message.platform_user_id ?? null,
      platformUserName: message.platform_user_name ?? null,
      platformBotUserId: message.platform_bot_user_id ?? null,
      runOutcome: message.run_outcome ?? null,
      runId: message.run_id,
      roundId: message.round_id,
      createdAt: new Date(message.created_at).toISOString(),
      occurredAt,
      ...(message.has_display_timeline ? { timelineOmitted: true } : {}),
    }]
  })
}

/**
 * 按 Python display-message store 的排序和游标规则读取消息页，并组装会话恢复所需数据。
 */
export function createAgentMessageHistory(pool: Pool, runtime: AgentMessageHistoryRuntime = {}) {
  return {
    async list(ownerId: string, sessionId: number, options: AgentMessagePageOptions) {
      const owned = await pool.query<SessionRow>(
        `SELECT session.id, session.source, session.title, session.chat_type,
                session.workspace_id, workspace.name AS workspace_name, session.session_context,
                session.execution_state, session.pending_message_count, session.bot_id
         FROM conversation_sessions AS session
         LEFT JOIN workspaces AS workspace ON workspace.id = session.workspace_id
         WHERE session.id = $1 AND session.user_id = $2`,
        [sessionId, ownerId],
      )
      if (!owned.rowCount) throw new AgentSessionNotFoundError()
      const session = owned.rows[0]!
      if (await runtime.recoverOrphanedSession?.(ownerId, sessionId))
        session.execution_state = 'idle'
      const filesystemAuthorizationEnabled = runtime.filesystemAuthorizationEnabled?.() ?? false
      const [activeStatuses, pendingQueue, grant, bot] = await Promise.all([
        runtime.activeStatuses?.([sessionId]) ?? Promise.resolve(new Map<number, boolean>()),
        pool.query<{ items: unknown }>(
          `SELECT items FROM conversation_pending_queues
           WHERE user_id = $1 AND queue_id = $2 LIMIT 1`,
          [ownerId, `session-${sessionId}`],
        ),
        filesystemAuthorizationEnabled
          ? pool.query<{ subject_id: string }>(
            `SELECT subject_id FROM filesystem_authorization_grants
             WHERE user_id = $1 AND subject_type = 'session' AND subject_id = $2
               AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
             LIMIT 1`,
            [ownerId, String(sessionId)],
          )
          : Promise.resolve({ rows: [] as { subject_id: string }[], rowCount: 0 }),
        session.source
          ? pool.query<{ owner_platform_user_id: string | null; bot_platform_user_id: string | null }>(
          `SELECT owner_platform_user_id,bot_platform_user_id FROM user_bots
             WHERE user_id = $1 AND platform = $2
               AND ($3::text IS NULL OR id::text = $3)
             ORDER BY id LIMIT 1`,
            [ownerId, session.source, session.bot_id ?? null],
          )
          : Promise.resolve({
            rows: [] as Array<{ owner_platform_user_id: string | null; bot_platform_user_id: string | null }>,
            rowCount: 0,
          }),
      ])
      const nowSeconds = (runtime.nowSeconds ?? (() => Date.now() / 1000))()
      const queueItems = Array.isArray(pendingQueue.rows[0]?.items)
        ? (pendingQueue.rows[0]!.items as unknown[]).flatMap((item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return []
          const record = item as Record<string, unknown>
          const { _claim_token: claimToken, _claim_until: claimUntil, ...visible } = record
          return [{
            ...visible,
            queue_id: `session-${sessionId}`,
            session_id: sessionId,
            claimed: Boolean(claimToken && typeof claimUntil === 'number' && claimUntil > nowSeconds),
          }]
        })
        : []
      const sessionContext = session.session_context && typeof session.session_context === 'object'
        && !Array.isArray(session.session_context)
        ? session.session_context as Record<string, unknown>
        : {}

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
        `SELECT message.id, message.role, message.content, message.client_message_id,
                message.quoted_text, message.references_json, message.platform_user_id,
                message.platform_user_name, message.platform_bot_user_id, message.run_outcome,
                message.im_platform_sent_ms, message.im_event_received_ms,
                (${timeKey})::text AS time_key,
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
      const timelineEvents = projectTimelineEvents(messages.map((message) => ({
        id: message.id,
        displayTimeline: message.display_timeline,
      }))) as Array<Record<string, unknown>>
      const cursorPresent = options.beforeId !== undefined || options.afterId !== undefined || options.throughId !== undefined
      const restoreActive = Boolean(options.restoreInteractions && !cursorPresent && options.runId === undefined)
      const interactionWindow: AgentInteractionHistoryWindow = options.runId !== undefined
        ? {
            restoreActive: false,
            toolCallIds: [...new Set(timelineEvents.flatMap((event) =>
              event.kind === 'tool' && event.runId === options.runId && typeof event.toolCallId === 'string'
                ? [event.toolCallId]
                : [],
            ))],
          }
        : {
            restoreActive,
            ...((options.throughId !== undefined || options.beforeId !== undefined) && cursorTime !== null
              ? { endBeforeMs: options.throughId !== undefined ? addOneMicrosecondMs(cursorTime) : cursorTime }
              : options.beforeId !== undefined && messages.length && cursorTime === null
                ? { endBeforeMs: addOneMicrosecondMs(messages.at(-1)!.time_key ?? messageTimeMs(messages.at(-1)!)) }
                : options.afterId !== undefined && hasNewer && messages.length
                  ? { endBeforeMs: messages.at(-1)!.time_key ?? messageTimeMs(messages.at(-1)!) }
                  : {}),
            ...((options.afterId !== undefined && cursorTime !== null)
              ? { startAtMs: cursorTime }
              : messages.length && hasMore
                ? { startAtMs: messages[0]!.time_key ?? messageTimeMs(messages[0]!) }
                : {}),
          }
      const emptyCursorPage = !messages.length && cursorPresent
      const interactions = emptyCursorPage || (options.runId !== undefined && interactionWindow.toolCallIds?.length === 0)
        ? []
        : await (runtime.listInteractions?.(ownerId, sessionId, interactionWindow) ?? Promise.resolve([]))
      return {
        session: {
          id: session.id,
          title: session.title,
          chatType: session.chat_type,
          ownerPlatformUserId: bot.rows[0]?.owner_platform_user_id ?? null,
          workspaceName: runtime.workspaceShellSupported?.() ? session.workspace_name : null,
          filesystemAuthorized: grant.rows.length > 0,
          filesystemAuthorizationEnabled,
          goalActive: Boolean(sessionContext.goal_mode && sessionContext.goal_text),
          goalStatus: sessionContext.goal_text
            ? sessionContext.goal_status === 'paused' ? 'paused' : 'active'
            : null,
        },
        active: Boolean(activeStatuses.get(sessionId)),
        executionState: session.execution_state,
        pendingMessageCount: Number(session.pending_message_count ?? 0),
        pendingQueue: queueItems,
        interactions,
        messages: projectMessageBodiesWithMentions(messages, session.source ?? undefined, await loadGroupMentionNames({
          pool,
          ownerId,
          sessionId,
          session: { chatType: session.chat_type, source: session.source },
          messages: messages.map((message) => ({
            content: message.content,
            quotedText: message.quoted_text ?? null,
            platformBotUserId: message.platform_bot_user_id ?? null,
          })),
          currentBotPlatformUserId: bot.rows[0]?.bot_platform_user_id ?? null,
        })),
        timelineEvents,
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
