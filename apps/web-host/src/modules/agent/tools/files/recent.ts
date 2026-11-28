import { projectRecentAttachments, type RecentAttachmentRow } from '@gugu/core/agent'
import type { RecentAttachmentsPort } from '@gugu/core/tools'
import type { Pool, QueryResultRow } from 'pg'
import type { AgentDispatchLease } from '../../run/dispatch.js'

interface AttachmentRow extends QueryResultRow, RecentAttachmentRow {}

/** owner/session 均来自当前 lease；返回字段只含附件展示元数据，不含存储键或正文。 */
export function createWebAgentRecentAttachmentsPort(
  pool: Pick<Pool, 'query'>,
  lease: AgentDispatchLease,
  now: () => number = Date.now,
): RecentAttachmentsPort {
  if (lease.input.v !== 2 || lease.input.source !== 'web') throw new TypeError('Web Agent 附件来源无法验证')
  const bound = Object.freeze({ ...lease.identity })
  return {
    async list(identity, signal) {
      signal.throwIfAborted()
      if (identity.ownerId !== bound.ownerId || identity.sessionId !== bound.sessionId || identity.runId !== bound.runId)
        throw new Error('Web Agent 附件运行身份不匹配')
      const staged = await pool.query<AttachmentRow>(`SELECT attach_id,name,ext,kind,platform,size,img_width,img_height,duration,created_at
        FROM chat_attachments WHERE user_id=$1 AND state='draft' ORDER BY created_at DESC`, [bound.ownerId])
      signal.throwIfAborted()
      const attached = await pool.query<AttachmentRow>(`SELECT a.attach_id,a.name,a.ext,a.kind,a.platform,a.size,a.img_width,a.img_height,a.duration,a.created_at
        FROM chat_attachments a
        JOIN conversation_messages m ON m.id=a.message_id
        JOIN conversation_sessions s ON s.id=m.session_id AND s.user_id=a.user_id
        WHERE a.user_id=$1 AND s.id=$2 AND a.state='attached'
        ORDER BY a.attached_at DESC,a.created_at DESC LIMIT 20`, [bound.ownerId, Number(bound.sessionId)])
      signal.throwIfAborted()
      return projectRecentAttachments(staged.rows, attached.rows, now())
    },
  }
}
