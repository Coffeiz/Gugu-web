import type { RecentAttachment, RecentAttachmentsPort } from '@gugu/core/tools'
import type { Pool, QueryResultRow } from 'pg'
import type { AgentDispatchLease } from '../../run/dispatch.js'

const draftTtlSeconds = 48 * 60 * 60
const legacyAgeTtlSeconds = 7 * 24 * 60 * 60

interface AttachmentRow extends QueryResultRow {
  attach_id: string
  name: string | null
  ext: string | null
  kind: string | null
  platform: string | null
  size: string | number | null
  img_width: number | null
  img_height: number | null
  duration: number | null
  created_at: Date | string
}

function ago(ttlLeft: number): string {
  if (!Number.isFinite(ttlLeft) || ttlLeft < 0) return '未知'
  const elapsed = Math.max(0, legacyAgeTtlSeconds - ttlLeft)
  if (elapsed < 3600) return `约${Math.max(1, Math.floor(elapsed / 60))}分钟前`
  if (elapsed < 86400) return `约${Math.floor(elapsed / 3600)}小时前`
  return `约${Math.floor(elapsed / 86400)}天前`
}

function mapRow(row: AttachmentRow, state: 'draft' | 'attached', now: number): RecentAttachment {
  const base: RecentAttachment = {
    attach_id: row.attach_id,
    name: row.name ?? '',
    ext: row.ext ?? '',
    kind: row.kind ?? 'binary',
    platform: row.platform,
    size_bytes: Number(row.size ?? 0),
    img_width: row.img_width === null ? null : Number(row.img_width),
    img_height: row.img_height === null ? null : Number(row.img_height),
    state,
  }
  if (state === 'attached') return { ...base, duration: row.duration === null ? null : Number(row.duration) }
  const createdAt = new Date(row.created_at).getTime()
  const elapsed = Number.isFinite(createdAt) ? Math.max(0, (now - createdAt) / 1000) : Number.NaN
  const ttlLeft = Number.isFinite(elapsed) ? Math.max(0, Math.trunc(draftTtlSeconds - elapsed)) : Number.NaN
  return { ...base, staged_about: ago(ttlLeft) }
}

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
      const timestamp = now()
      if (!Number.isFinite(timestamp)) throw new RangeError('附件列表时钟无效')
      return [
        ...staged.rows.map(row => mapRow(row, 'draft', timestamp)),
        ...attached.rows.map(row => mapRow(row, 'attached', timestamp)),
      ]
    },
  }
}
