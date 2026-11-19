import type { Pool } from 'pg'
import type { RunCheckpoint } from '@gugu/core/agent'
import { projectAgentMessageBodiesWithMentions, projectAgentTimelineEvents, type AgentInteractionHistoryWindow, type AgentMessageProjectionRow } from '@gugu/core/agent-sessions'
import { loadGroupMentionNames } from './agent-group-mentions.js'
import { readActiveSessionFilesystemGrant } from '../agent-filesystem-authorization.js'

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
  activeStatuses?(sessionIds: number[], ownerId: string): Promise<Map<number, boolean>>
  readActiveRun?(ownerId: string, sessionId: number): Promise<Pick<RunCheckpoint<unknown>, 'status' | 'displayTimeline' | 'anchorMessageId'> | null>
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

type MessageRow = AgentMessageProjectionRow & {
  conversation_seq: string
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

const hasDisplayTimeline = "(message.display_timeline IS NOT NULL AND message.display_timeline::jsonb <> 'null'::jsonb)"
const timeKey = `COALESCE(
  message.im_platform_sent_ms::numeric,
  message.im_event_received_ms::numeric,
  EXTRACT(EPOCH FROM message.created_at) * 1000
)`

function addOneMicrosecondMs(value: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value)
  if (!match || /[1-9]/.test((match[3] ?? '').slice(3))) throw new Error('交互窗口时间无效')
  const magnitude = BigInt(match[2]!) * 1000n + BigInt((match[3] ?? '').slice(0, 3).padEnd(3, '0'))
  const units = (match[1] === '-' ? -magnitude : magnitude) + 1n
  const absolute = units < 0n ? -units : units
  return `${units < 0n ? '-' : ''}${absolute / 1000n}.${String(absolute % 1000n).padStart(3, '0')}`
}

function messageTimeMs(message: MessageRow): string {
  const platformSentAt = Number(message.im_platform_sent_ms)
  if (platformSentAt > 0) return String(platformSentAt)
  const receivedAt = Number(message.im_event_received_ms)
  if (receivedAt > 0) return String(receivedAt)
  return message.time_key ?? String(new Date(message.created_at).getTime())
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
         LEFT JOIN workspaces AS workspace ON workspace.id = session.workspace_id AND workspace.user_id = session.user_id
         WHERE session.id = $1 AND session.user_id = $2`,
        [sessionId, ownerId],
      )
      if (!owned.rowCount) throw new AgentSessionNotFoundError()
      const session = owned.rows[0]!
      if (await runtime.recoverOrphanedSession?.(ownerId, sessionId))
        session.execution_state = 'idle'
      const filesystemAuthorizationEnabled = runtime.filesystemAuthorizationEnabled?.() ?? false
      const [activeStatuses, pendingQueue, grant, bot] = await Promise.all([
        runtime.activeStatuses?.([sessionId], ownerId) ?? Promise.resolve(new Map<number, boolean>()),
        pool.query<{ items: unknown }>(
          `SELECT items FROM conversation_pending_queues
           WHERE user_id = $1 AND queue_id = $2 LIMIT 1`,
          [ownerId, `session-${sessionId}`],
        ),
        filesystemAuthorizationEnabled
          ? readActiveSessionFilesystemGrant(pool, ownerId, sessionId, new Date())
          : Promise.resolve(null),
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
        `(message.content_json IS NULL OR ${hasDisplayTimeline})`,
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
                ${hasDisplayTimeline} AS has_display_timeline,
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
            `(message.content_json IS NULL OR ${hasDisplayTimeline})`,
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
      const timelineEvents = projectAgentTimelineEvents(messages.map((message) => ({
        id: message.id,
        displayTimeline: message.display_timeline,
      }))) as Array<Record<string, unknown>>
      const cursorPresent = options.beforeId !== undefined || options.afterId !== undefined || options.throughId !== undefined
      const restoreActive = Boolean(options.restoreInteractions && !cursorPresent && options.runId === undefined)
      if (restoreActive && activeStatuses.get(sessionId)) {
        const run = await runtime.readActiveRun?.(ownerId, sessionId)
        const anchor = messages.find(message => String(message.id) === run?.anchorMessageId)
        if (run && anchor && ['preparing', 'running', 'waiting'].includes(run.status)) {
          const existing = new Set(timelineEvents.map(event => event.eventId))
          const displayTimeline = run.displayTimeline
            .filter(item => !existing.has(item.eventId))
            .map(({ toolResult: _toolResult, ...item }) => item)
          // 进行中的详情由 SSE 提供，快照只投影用户可见时间线。
          timelineEvents.push(...projectAgentTimelineEvents([{ id: anchor.id, displayTimeline }]) as Array<Record<string, unknown>>)
        }
      }
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
          filesystemAuthorized: grant !== null,
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
        messages: projectAgentMessageBodiesWithMentions(messages, session.source ?? undefined, await loadGroupMentionNames({
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
