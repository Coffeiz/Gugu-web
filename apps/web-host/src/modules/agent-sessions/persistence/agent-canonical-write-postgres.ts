import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { MessageArea, canonicalToolsUsed, stableJson, isCompactedSummaryMessage, unwrapCompactedSummary, validateCompactSummary, updateBaselineSnapshot } from '@gugu/core/agent'
import type { CanonicalRunContext, RunCheckpoint, RunIdentity } from '@gugu/core/agent'
import { sanitizeMediaPayload } from '@gugu/core/agent/context/messages'
import { recordAgentUsage, type AgentUsageConfig, type AgentUsageLabels } from './agent-usage-postgres.js'
import { lockCanonicalHistoryBaseline } from './agent-history-baseline-postgres.js'
import type { AgentRunHistoryWrite } from './agent-run-store-postgres.js'
import { enqueuePostgresAgentRagRebuild } from './agent-rag-job-postgres.js'

const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')
const shortDigest = (value: unknown) => digest(value).slice(0, 16)

/** 与 Python session_snapshot.baseline_hash 的完整 SHA-256 格式互通。 */
export function canonicalBaselineHash(rows: readonly { id: string; role: string; content: string; content_json: unknown }[]): string {
  return digest(rows.map(row => ({ id: Number(row.id), role: row.role, content: row.content_json ?? row.content ?? '' })))
}

/** 由可信模型选择服务注入账本配置；与 RunStore 的终态提交共用事务。 */
export function createCanonicalHistoryWriter(resolveConfig: (identity: RunIdentity, modelIdentity: string, client: PoolClient) => Promise<AgentUsageConfig>, options?: {
  usageSource?: AgentUsageLabels['source'] | ((identity: RunIdentity, client: PoolClient) => Promise<AgentUsageLabels['source']>)
  commitContinuation?(client: PoolClient, identity: RunIdentity, context: CanonicalRunContext): Promise<void>
  afterSuccess?(client: PoolClient, identity: RunIdentity, history: AgentRunHistoryWrite<CanonicalRunContext>, checkpoint: RunCheckpoint<CanonicalRunContext>): Promise<void>
}) {
  return async (client: PoolClient, identity: RunIdentity, history: AgentRunHistoryWrite<CanonicalRunContext>, checkpoint: RunCheckpoint<CanonicalRunContext>): Promise<void> => {
    const context = history.context
    if (context.identity.ownerId !== identity.ownerId || context.identity.sessionId !== identity.sessionId || context.identity.runId !== identity.runId
      || checkpoint.identity.ownerId !== identity.ownerId || checkpoint.identity.sessionId !== identity.sessionId || checkpoint.identity.runId !== identity.runId)
      throw new Error('Agent 历史身份不匹配')
    // 原生续接引用属于本次运行，由 Provider 管理，聊天历史仅提交可持久化的消息。
    const config = await resolveConfig(identity, context.modelIdentity, client)
    if (context.continuationRef && history.outcome === 'success') await options?.commitContinuation?.(client, identity, context)
    const session = await client.query<{ last_message_seq: string }>(
      `SELECT last_message_seq::text FROM conversation_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE`, [identity.sessionId, identity.ownerId])
    if (!session.rows[0]) throw new Error('Agent 会话不存在')
    let compacted: { summary: string; baseline: number; hash: string; snapshot: NonNullable<CanonicalRunContext['sourceEffects']>['sessionSnapshot']['state'] } | null = null
    if (history.outcome === 'success' && context.compactions.length) {
      await lockCanonicalHistoryBaseline(client, identity, context)
      const result = context.compactions.at(-1)!.result
      const ids = context.compactions.flatMap(item => item.result.coversUntilMessageIds)
      if (context.compactions.some(item => !item.result.changed || item.result.coversUnpersisted !== false)
        || !ids.length || new Set(ids).size !== ids.length || !context.sourceEffects
        || ids.some(id => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))))
        throw new Error('Agent 压缩覆盖边界无效')
      const rows = await client.query<{ id: string; role: string; content: string; content_json: unknown; effective: string }>(
        `SELECT id::text, role, content, content_json, coalesce(history_anchor_seq,conversation_seq)::text AS effective
         FROM conversation_messages WHERE session_id = $1 AND role <> 'summary'
           AND (run_id IS NULL OR run_id NOT LIKE 'im-pending:%')
           AND coalesce(history_anchor_seq,conversation_seq) > $2
         ORDER BY coalesce(history_anchor_seq,conversation_seq), (history_anchor_seq IS NULL), conversation_seq`,
        [identity.sessionId, context.historyBaseline!.baselineSeq])
      const covered = rows.rows.slice(0, ids.length)
      if (covered.length !== ids.length || covered.some((row, index) => row.id !== ids[index]))
        throw new Error('Agent 压缩覆盖范围已变化')
      const baseline = Number(covered.at(-1)!.effective)
      if (rows.rows[ids.length] && Number(rows.rows[ids.length]!.effective) <= baseline)
        throw new Error('Agent 压缩切断了同一历史锚点')
      if (!Number.isSafeInteger(baseline) || baseline <= context.historyBaseline!.baselineSeq)
        throw new Error('Agent 压缩水位无效')
      const candidates = result.messages.filter(isCompactedSummaryMessage)
      if (candidates.length !== 1 || typeof candidates[0]!.content !== 'string') throw new Error('Agent 压缩摘要无效')
      const summary = unwrapCompactedSummary(candidates[0]!.content)
      if (!validateCompactSummary(summary)) throw new Error('Agent 压缩摘要无效')
      const hash = canonicalBaselineHash(covered)
      const snapshot = updateBaselineSnapshot(context.sourceEffects.sessionSnapshot.state, [{ role: 'summary', content: summary }],
        { digest, nextId: randomUUID, now: Date.now }, { baselineMessageSeq: baseline })
      compacted = { summary, baseline, hash, snapshot }
    }
    const area = MessageArea.restore({ digest, nextId: randomUUID }, context.prepared.area)
    const delta = area.persistenceDelta(history.outcome === 'interruption' ? 'interruption' : 'success')
    const anchorEntry = [...area.entries].reverse().find(entry => entry.persistedMessageId != null && ['user', 'reference', 'attachment'].includes(entry.source))
    let anchor: { conversation_seq: string; created_at: Date; sent_at: Date | null; im_platform_sent_ms: string | null; im_event_received_ms: string | null } | undefined
    if (anchorEntry) {
      const result = await client.query<typeof anchor extends infer T ? NonNullable<T> : never>(
        `SELECT conversation_seq::text, created_at, sent_at, im_platform_sent_ms::text, im_event_received_ms::text
           FROM conversation_messages WHERE id = $1 AND session_id = $2 AND role = 'user'`, [anchorEntry.persistedMessageId, identity.sessionId])
      anchor = result.rows[0]
      if (!anchor) throw new Error('Agent 历史锚点不存在')
    }
    if (delta.userAnchorSequence !== null && !anchor) throw new Error('Agent 历史锚点无效')
    const receipt = await client.query(`INSERT INTO conversation_batches (session_id, version, run_id, round_id, digest, created_at)
      VALUES ($1,'finalize-v1',$2,'round-1',$3,clock_timestamp()) ON CONFLICT (session_id,digest) DO NOTHING RETURNING id`,
    [identity.sessionId, identity.runId, shortDigest({ finalized_run: identity.runId })])
    if (receipt.rowCount !== 1) throw new Error('Agent 终态已提交')
    if (anchorEntry && history.outcome !== 'silent') await client.query(
      `UPDATE conversation_messages SET run_id = $3, round_id = 'round-1' WHERE id = $1 AND session_id = $2`,
      [anchorEntry.persistedMessageId, identity.sessionId, identity.runId])
    const groups = delta.batches.map(batch => ({ entries: batch.entries, metadata: batch.metadata }))
    groups.push(...delta.entries.filter(entry => !entry.batchId).map(entry => ({ entries: [entry], metadata: { kind: entry.source } })))
    groups.sort((a, b) => a.entries[0]!.sequence - b.entries[0]!.sequence)
    const hasDisplay = history.outcome !== 'silent' && Boolean(history.text || checkpoint.files.length || checkpoint.displayTimeline.length)
    const total = (history.outcome === 'silent' ? 0 : delta.entries.length) + Number(hasDisplay) + Number(compacted !== null)
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
    if (history.outcome !== 'silent') for (const group of groups) {
      const first = group.entries[0]!, metadata = { ...group.metadata, source: first.source, sequence_start: first.sequence,
        sequence_end: group.entries.at(-1)!.sequence, outcome: history.outcome === 'interruption' ? 'interruption' : 'success' }
      const batch = await client.query<{ id: string }>(`INSERT INTO conversation_batches (session_id,version,run_id,round_id,digest,created_at)
        VALUES ($1,'v1',$2,$3,$4,clock_timestamp()) ON CONFLICT (session_id,digest) DO NOTHING RETURNING id::text`,
      [identity.sessionId, identity.runId, first.roundId || 'round-1', shortDigest({ messages: group.entries.map(entry => entry.message), metadata, run_id: identity.runId })])
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
    if (hasDisplay) {
      const timeline = checkpoint.displayTimeline.map(item => item.kind === 'tool' && (item.toolStatus === 'queued' || item.toolStatus === 'running')
        ? { ...item, toolStatus: 'stopped', updatedAt: new Date().toISOString() } : item)
      const text = history.outcome === 'interruption' && history.text ? `${history.text}\n\n[本轮已中止，以上内容未完成]` : history.text
      await client.query(`INSERT INTO conversation_messages (session_id,conversation_seq,role,content,files,display_timeline,run_id,round_id,created_at,sent_at)
        VALUES ($1,$2,'assistant',$3,$4::jsonb,$5::jsonb,$6,'round-1',clock_timestamp(),clock_timestamp())`,
      [identity.sessionId, ++sequence, text, checkpoint.files.length ? JSON.stringify(sanitizeMediaPayload(checkpoint.files)) : null,
        timeline.length ? JSON.stringify(sanitizeMediaPayload(timeline)) : null, identity.runId])
    }
    if (context.providerCacheAnchor) await client.query(`UPDATE conversation_sessions SET session_context = jsonb_set(coalesce(session_context::jsonb,'{}'::jsonb), '{provider_cache_anchor}', $3::jsonb)
      WHERE id = $1 AND user_id = $2`, [identity.sessionId, identity.ownerId, JSON.stringify(context.providerCacheAnchor.anchor)])
    if (total > 0) await enqueuePostgresAgentRagRebuild(client, identity.ownerId, 'conversation')
    const source = typeof options?.usageSource === 'function' ? await options.usageSource(identity, client) : options?.usageSource ?? 'web'
    await recordAgentUsage(client, identity, checkpoint.totalUsage, config, checkpoint.providerRounds, canonicalToolsUsed(checkpoint, delta.entries), { scenario: 'chat', source })
    if (history.outcome === 'success') await options?.afterSuccess?.(client, identity, history, checkpoint)
  }
}
