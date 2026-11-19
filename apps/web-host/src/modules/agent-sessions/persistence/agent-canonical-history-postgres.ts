import type { Pool } from 'pg'
import { createPostgresHistoryImages } from '@gugu/core/agent/context/history/images-postgres'
import type { HistoryReaderPort, PersistedHistoryRow, Json } from '@gugu/core/agent'

interface HistoryRow {
  baseline: string; baseline_hash: string | null; snapshot_hash: string | null; id: string | null; conversation_seq: string | null; history_anchor_seq: string | null
  role: string | null; content: string | null; content_json: Json | null; covers_until_seq: string | null
  run_id: string | null; round_id: string | null; canonical_batch_id: string | null
  im_platform_sent_ms: string | null; im_event_received_ms: string | null
  created_at: string | null; sent_at: string | null; quoted_text: string | null; files: Json[] | null
  platform_user_id: string | null; platform_user_name: string | null; source: string | null; chat_type: string | null
}

function number(value: string | null): number | null {
  if (value == null) return null
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('历史序号无效')
  return result
}

/** 单条查询提供同一快照的 owner 授权、baseline 与正文；图片由独立受限端口读取。 */
export function createPostgresCanonicalHistoryReader(pool: Pick<Pool, 'query' | 'connect'>): HistoryReaderPort {
  return {
    images: createPostgresHistoryImages(pool),
    async read(identity, signal) {
      signal?.throwIfAborted()
      if (!identity.ownerId || !/^[1-9]\d*$/.test(identity.sessionId) || !Number.isSafeInteger(Number(identity.sessionId)))
        throw new TypeError('Agent 会话身份无效')
      const result = await pool.query<HistoryRow>(
        `SELECT s.baseline_message_seq::text AS baseline, s.baseline_message_hash AS baseline_hash, s.snapshot_hash, m.id::text, m.conversation_seq::text,
                m.history_anchor_seq::text, m.role, m.content, m.content_json, m.covers_until_seq::text,
                m.run_id, m.round_id, m.canonical_batch_id::text, m.im_platform_sent_ms::text,
                m.im_event_received_ms::text, m.created_at::text, m.sent_at::text, m.quoted_text,
                m.files, m.platform_user_id, m.platform_user_name, s.source, m.chat_type
           FROM conversation_sessions s LEFT JOIN conversation_messages m ON m.session_id = s.id
          WHERE s.user_id = $1 AND s.id = $2`, [identity.ownerId, identity.sessionId])
      signal?.throwIfAborted()
      if (!result.rows.length) throw new Error('Agent 会话不存在')
      const rows: PersistedHistoryRow[] = result.rows.filter(row => row.id != null).map(row => ({
        ...identity, id: row.id!, conversationSeq: number(row.conversation_seq)!, historyAnchorSeq: number(row.history_anchor_seq),
        role: row.role!, content: row.content ?? '', contentJson: row.content_json ?? undefined,
        coversUntilSeq: number(row.covers_until_seq), runId: row.run_id, roundId: row.round_id,
        canonicalBatchId: row.canonical_batch_id, platformSentMs: number(row.im_platform_sent_ms),
        eventReceivedMs: number(row.im_event_received_ms), createdAt: row.created_at, sentAt: row.sent_at,
        quote: row.quoted_text, files: row.files ?? undefined, senderId: row.platform_user_id,
        senderName: row.platform_user_name, source: row.source, chatType: row.chat_type,
      }))
      return { baselineSeq: number(result.rows[0]!.baseline)!, baselineIdentity: { baselineSeq: number(result.rows[0]!.baseline)!, baselineHash: result.rows[0]!.baseline_hash, snapshotHash: result.rows[0]!.snapshot_hash }, rows }
    },
  }
}
