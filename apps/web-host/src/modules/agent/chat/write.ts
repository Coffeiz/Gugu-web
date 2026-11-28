import type { PoolClient } from 'pg'
import { canonicalToolsUsed, projectCanonicalRunHistory, projectDurableHistoryCompaction } from '@gugu/core/agent'
import type { CanonicalRunContext, RunCheckpoint, RunIdentity } from '@gugu/core/agent'
import { sanitizeMediaPayload } from '@gugu/core/agent/context/messages'
import { recordAgentUsage, type AgentUsageConfig, type AgentUsageLabels } from '../run/usage.js'
import { lockCanonicalHistoryBaseline } from './baseline.js'
import type { AgentRunHistoryWrite } from '../run/store.js'
import { enqueuePostgresAgentRagRebuild } from '../rag/jobs.js'

export { canonicalBaselineHash } from '@gugu/core/agent'

async function prepareDurableCompaction(client: PoolClient, identity: RunIdentity, context: CanonicalRunContext, anchorSeq: string | undefined) {
  if (!await lockCanonicalHistoryBaseline(client, identity, context)) return null
  const rows = await client.query<Parameters<typeof projectDurableHistoryCompaction>[1][number]>(
    `SELECT id::text, role, content, content_json, coalesce(history_anchor_seq,conversation_seq)::text AS effective,
       run_id AS "runId", round_id AS "roundId", canonical_batch_id::text AS "canonicalBatchId", covers_until_seq AS "coversUntilSeq"
     FROM conversation_messages WHERE session_id = $1
       AND (run_id IS NULL OR run_id NOT LIKE 'im-pending:%')
       AND NOT (role = 'assistant' AND canonical_batch_id IS NULL AND display_timeline IS NOT NULL
         AND btrim(coalesce(content, '')) = '' AND content_json IS NULL
         AND (files IS NULL OR files = '[]'::jsonb) AND coalesce(quoted_text, '') = '')
       AND (role='summary' OR coalesce(history_anchor_seq,conversation_seq) > $2)
     ORDER BY (role<>'summary'),coalesce(history_anchor_seq,conversation_seq), (history_anchor_seq IS NULL), conversation_seq`,
    [identity.sessionId, context.historyBaseline!.baselineSeq])
  return projectDurableHistoryCompaction(context, rows.rows, anchorSeq)
}

/** 由可信模型选择服务注入账本配置；与 RunStore 的终态提交共用事务。 */
export function createCanonicalHistoryWriter(resolveConfig: (identity: RunIdentity, modelIdentity: string, client: PoolClient) => Promise<AgentUsageConfig>, options?: {
  postCommitCompaction?: boolean
  usageSource?: AgentUsageLabels['source'] | ((identity: RunIdentity, client: PoolClient) => Promise<AgentUsageLabels['source']>)
  commitContinuation?(client: PoolClient, identity: RunIdentity, context: CanonicalRunContext): Promise<void>
  afterSuccess?(client: PoolClient, identity: RunIdentity, history: AgentRunHistoryWrite<CanonicalRunContext>, checkpoint: RunCheckpoint<CanonicalRunContext>): Promise<void>
}) {
  return async (client: PoolClient, identity: RunIdentity, history: AgentRunHistoryWrite<CanonicalRunContext>, checkpoint: RunCheckpoint<CanonicalRunContext>): Promise<void> => {
    const context = history.context
    const { delta, failed, anchorEntry, batches, display, outcome, receipt: receiptDigest } = projectCanonicalRunHistory(identity, history, checkpoint)
    // 原生续接引用属于本次运行，由 Provider 管理，聊天历史仅提交可持久化的消息。
    const config = await resolveConfig(identity, context.modelIdentity, client)
    if (context.continuationRef && history.outcome === 'success') await options?.commitContinuation?.(client, identity, context)
    const session = await client.query<{ last_message_seq: string }>(
      `SELECT last_message_seq::text FROM conversation_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE`, [identity.sessionId, identity.ownerId])
    if (!session.rows[0]) throw new Error('Agent 会话不存在')
    let anchor: { conversation_seq: string; created_at: Date; sent_at: Date | null; im_platform_sent_ms: string | null; im_event_received_ms: string | null } | undefined
    if (anchorEntry) {
      const result = await client.query<typeof anchor extends infer T ? NonNullable<T> : never>(
        `SELECT conversation_seq::text, created_at, sent_at, im_platform_sent_ms::text, im_event_received_ms::text
           FROM conversation_messages WHERE id = $1 AND session_id = $2 AND role = 'user'`, [anchorEntry.persistedMessageId, identity.sessionId])
      anchor = result.rows[0]
      if (!anchor) throw new Error('Agent 历史锚点不存在')
    }
    if (delta.userAnchorSequence !== null && !anchor) throw new Error('Agent 历史锚点无效')
    // 在终态事务中校验基线和用户锚点，再按统一保留规则整理旧历史。
    const compacted = !options?.postCommitCompaction && history.outcome === 'success'
      && (context.compactions.length || context.overflowTrimmed)
      && context.historyBaseline && context.sourceEffects && anchor
      ? await prepareDurableCompaction(client, identity, context, anchor.conversation_seq) : null
    const receipt = await client.query(`INSERT INTO conversation_batches (session_id, version, run_id, round_id, digest, created_at)
      VALUES ($1,'finalize-v1',$2,'round-1',$3,clock_timestamp()) ON CONFLICT (session_id,digest) DO NOTHING RETURNING id`,
    [identity.sessionId, identity.runId, receiptDigest])
    if (receipt.rowCount !== 1) throw new Error('Agent 终态已提交')
    if (anchorEntry && history.outcome !== 'silent') await client.query(
      `UPDATE conversation_messages SET run_id = $3, round_id = 'round-1', run_outcome = $4::jsonb WHERE id = $1 AND session_id = $2`,
      [anchorEntry.persistedMessageId, identity.sessionId, identity.runId, outcome])
    const total = (history.outcome === 'silent' ? 0 : delta.entries.length) + Number(display !== null) + Number(compacted !== null)
    let sequence = Number(session.rows[0].last_message_seq)
    if (!Number.isSafeInteger(sequence) || sequence < 0 || !Number.isSafeInteger(sequence + total)) throw new Error('Agent 会话序号无效')
    if (total) await client.query('UPDATE conversation_sessions SET last_message_seq = last_message_seq + $3 WHERE id = $1 AND user_id = $2', [identity.sessionId, identity.ownerId, total])
    if (compacted) {
      await client.query(`DELETE FROM conversation_messages WHERE session_id = $1 AND role = 'summary'`, [identity.sessionId])
      await client.query(`INSERT INTO conversation_messages (session_id,conversation_seq,role,content,covers_until_seq,created_at)
        VALUES ($1,$2,'summary',$3,$4,clock_timestamp())`, [identity.sessionId, ++sequence, compacted.summary, compacted.baseline])
      await client.query(`UPDATE conversation_sessions SET baseline_message_seq=$3, baseline_message_hash=$4,
        session_context=$5::jsonb, context_epoch=$6, snapshot_hash=$7, session_info_hash=$8, snapshot_expires_at=$9
        WHERE id=$1 AND user_id=$2`, [identity.sessionId, identity.ownerId, compacted.baseline, compacted.hash,
        JSON.stringify(compacted.snapshot.context), compacted.snapshot.contextEpoch, compacted.snapshot.snapshotHash,
        compacted.snapshot.sessionInfoHash, compacted.snapshot.snapshotExpiresAt === null ? null : new Date(compacted.snapshot.snapshotExpiresAt)])
    }
    if (history.outcome !== 'silent') for (const group of batches) {
      const batch = await client.query<{ id: string }>(`INSERT INTO conversation_batches (session_id,version,run_id,round_id,digest,created_at)
        VALUES ($1,'v1',$2,$3,$4,clock_timestamp()) ON CONFLICT (session_id,digest) DO NOTHING RETURNING id::text`,
      [identity.sessionId, identity.runId, group.round, group.digest])
      if (!batch.rows[0]) throw new Error('Agent 历史批次已存在')
      for (const entry of group.entries) {
        const value = sanitizeMediaPayload(entry.message.content)
        const beforeAnchor = anchor && delta.userAnchorSequence !== null && entry.sequence < delta.userAnchorSequence
        await client.query(`INSERT INTO conversation_messages (session_id,conversation_seq,history_anchor_seq,role,content,content_json,
          canonical_batch_id,run_id,round_id,created_at,sent_at,im_platform_sent_ms,im_event_received_ms)
          VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,
            CASE WHEN $10::timestamptz IS NULL THEN clock_timestamp() ELSE $10::timestamptz + $11 * interval '1 microsecond' END,
            CASE WHEN $12::timestamptz IS NULL THEN clock_timestamp() ELSE $12::timestamptz + $11 * interval '1 microsecond' END,$13,$14)`,
        [identity.sessionId, ++sequence, beforeAnchor ? anchor!.conversation_seq : null, entry.message.role,
          typeof value === 'string' ? value : '', typeof value === 'string' ? null : JSON.stringify(value), batch.rows[0].id,
          identity.runId, entry.roundId || 'round-1', beforeAnchor || history.outcome === 'interruption' ? anchor?.created_at ?? null : null,
          beforeAnchor || history.outcome === 'interruption' ? entry.sequence - delta.userAnchorSequence! : 0,
          beforeAnchor || history.outcome === 'interruption' ? anchor?.sent_at ?? anchor?.created_at ?? null : null,
          anchor?.im_platform_sent_ms ?? null, anchor?.im_event_received_ms ?? null])
      }
    }
    if (display) {
      await client.query(`INSERT INTO conversation_messages (session_id,conversation_seq,role,content,files,display_timeline,run_id,round_id,created_at,sent_at)
        VALUES ($1,$2,'assistant',$3,$4::jsonb,$5::jsonb,$6,$7,clock_timestamp(),clock_timestamp())`,
      [identity.sessionId, ++sequence, display.text, display.files, display.timeline, identity.runId, display.roundId])
    }
    if (!failed && ((context.compactions.length === 0 && !context.overflowTrimmed) || compacted) && context.providerCacheAnchor) await client.query(`UPDATE conversation_sessions SET session_context = jsonb_set(coalesce(session_context::jsonb,'{}'::jsonb), '{provider_cache_anchor}', $3::jsonb)
      WHERE id = $1 AND user_id = $2`, [identity.sessionId, identity.ownerId, JSON.stringify(context.providerCacheAnchor.anchor)])
    if (total > 0) await enqueuePostgresAgentRagRebuild(client, identity.ownerId, 'conversation')
    const source = typeof options?.usageSource === 'function' ? await options.usageSource(identity, client) : options?.usageSource ?? 'web'
    await recordAgentUsage(client, identity, checkpoint.totalUsage, config, checkpoint.providerRounds, canonicalToolsUsed(checkpoint, delta.entries), { scenario: 'chat', source })
    if (history.outcome === 'success') await options?.afterSuccess?.(client, identity, history, checkpoint)
  }
}
