import type { RunIdentity } from '@gugu/core/agent'
import type { Pool } from 'pg'

/** 精确 ID 只匹配当前 owner 的已挂载附件；无 ID 时仅查询当前会话最近一项。 */
export async function readSessionToolAttachments(
  pool: Pick<Pool, 'query'>, identity: RunIdentity, ids: readonly string[] | null, allowCrossSession = false,
) {
  const session = ids && allowCrossSession ? null : Number(identity.sessionId)
  if (session !== null && (!Number.isInteger(session) || session < 1 || session > 2_147_483_647)) return []
  const { rows } = await pool.query<{ attach_id: string; kind: string; size: string | number }>(
    `SELECT a.attach_id,a.kind,a.size FROM chat_attachments a
      JOIN conversation_messages m ON m.id=a.message_id
      JOIN conversation_sessions s ON s.id=m.session_id AND s.user_id=a.user_id
      WHERE a.user_id=$1 AND ($2::integer IS NULL OR s.id=$2) AND a.state='attached'
        AND ($3::text[] IS NULL OR a.attach_id=ANY($3))
      ORDER BY a.created_at DESC,a.id DESC LIMIT $4`,
    [identity.ownerId, session, ids, ids?.length ?? 1],
  )
  return rows
}
