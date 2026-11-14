import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { Pool } from 'pg'

export interface AgentSessionRouteOptions {
  /** Host authentication hook; it must reject before the identity accessor or store runs. */
  requireUser: preHandlerHookHandler
  /** Reads the authenticated RequestContext created by the Host, never request input. */
  userIdFromRequest(request: FastifyRequest): string
  list(ownerId: string): Promise<unknown[]>
}

export function registerAgentSessionRoute(app: FastifyInstance, options: AgentSessionRouteOptions): void {
  app.get('/api/v1/agent/sessions', { preHandler: options.requireUser }, async (request) =>
    options.list(options.userIdFromRequest(request)),
  )
}

export interface AgentSessionRuntime {
  /** Redis snapshot adapter; absent IDs mean status is unknown, matching Python's dict.get. */
  activeStatuses(sessionIds: number[]): Promise<Map<number, boolean>>
  filesystemAuthorizationEnabled(): boolean
  workspaceShellSupported(): boolean
}

interface SessionRow {
  id: number
  title: string
  source: string | null
  chat_type: string | null
  workspace_name: string | null
  session_context: Record<string, unknown> | null
  updated_at_iso: string
  created_at_iso: string
}

function isoUtc(value: string): string {
  return `${value.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')}Z`
}

const sessionSelect = `
  SELECT session.id, session.title, session.source, session.chat_type,
         workspace.name AS workspace_name, session.session_context,
         to_char(session.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS updated_at_iso,
         to_char(session.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS created_at_iso
  FROM conversation_sessions AS session
  LEFT JOIN workspaces AS workspace ON workspace.id = session.workspace_id
  WHERE session.user_id = $1 AND `

export function createAgentSessionLister(pool: Pool, runtime: AgentSessionRuntime) {
  return async function listAgentSessions(ownerId: string) {
    // Keep separate source limits so a busy Web account cannot hide low-frequency IM sessions.
    const [web, im] = await Promise.all([
      pool.query<SessionRow>(
        `${sessionSelect}(session.source IS NULL OR session.source = 'web')
         ORDER BY session.updated_at DESC LIMIT 50`, [ownerId],
      ),
      pool.query<SessionRow>(
        `${sessionSelect}(session.source IS NOT NULL AND session.source <> 'web')
         ORDER BY session.updated_at DESC LIMIT 50`, [ownerId],
      ),
    ])
    const sessions = [...web.rows, ...im.rows].sort((left, right) =>
      right.updated_at_iso.localeCompare(left.updated_at_iso),
    )
    if (sessions.length === 0) return []

    const ids = sessions.map(({ id }) => id)
    const webIds = sessions.filter((row) => !row.source || row.source === 'web').map(({ id }) => id)
    const filesystemAuthorizationEnabled = runtime.filesystemAuthorizationEnabled()
    const [running, authorized, latestReplies] = await Promise.all([
      runtime.activeStatuses(ids),
      filesystemAuthorizationEnabled
        ? pool.query<{ subject_id: string }>(
          `SELECT subject_id FROM filesystem_authorization_grants
           WHERE user_id = $1 AND subject_type = 'session' AND revoked_at IS NULL
             AND (expires_at IS NULL OR expires_at > now())`, [ownerId],
        )
        : Promise.resolve({ rows: [] as { subject_id: string }[] }),
      webIds.length
        ? pool.query<{ session_id: number; id: number }>(
          `WITH latest AS (
             SELECT session_id, max(conversation_seq) AS conversation_seq
             FROM conversation_messages
             WHERE session_id = ANY($1::integer[]) AND role = 'assistant' AND content_json IS NULL
               AND (content <> '' OR (files IS NOT NULL AND files::text NOT IN ('[]', 'null')))
             GROUP BY session_id
           )
           SELECT message.session_id, message.id
           FROM conversation_messages AS message
           JOIN latest ON latest.session_id = message.session_id
                      AND latest.conversation_seq = message.conversation_seq`, [webIds],
        )
        : Promise.resolve({ rows: [] as { session_id: number; id: number }[] }),
    ])
    const authorizedSessionIds = new Set(authorized.rows
      .map(({ subject_id }) => /^\d+$/.test(subject_id) ? Number(subject_id) : 0)
      .filter((id) => id > 0))
    const repliesBySession = new Map(latestReplies.rows.map(({ session_id, id }) => [session_id, id]))
    const workspaceShellSupported = runtime.workspaceShellSupported()

    return sessions.map((session) => {
      const context = session.session_context && typeof session.session_context === 'object'
        ? session.session_context
        : {}
      const hasGoal = Boolean(context.goal_text)
      const row: Record<string, unknown> = {
        id: session.id,
        title: session.title,
        source: session.source,
        chatType: session.chat_type,
        workspaceName: workspaceShellSupported ? session.workspace_name : null,
        goalActive: Boolean(context.goal_mode && context.goal_text),
        goalStatus: hasGoal ? (context.goal_status === 'paused' ? 'paused' : 'active') : null,
        filesystemAuthorized: filesystemAuthorizationEnabled && authorizedSessionIds.has(session.id),
        filesystemAuthorizationEnabled,
        updatedAt: isoUtc(session.updated_at_iso),
        createdAt: isoUtc(session.created_at_iso),
        isRunning: running.get(session.id),
      }
      if (!session.source || session.source === 'web')
        row.lastAssistantId = repliesBySession.get(session.id) ?? 0
      return row
    })
  }
}
