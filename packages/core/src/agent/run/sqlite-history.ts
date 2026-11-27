import { sql, type Kysely, type Transaction } from 'kysely'
import { databaseTime, nowUtc } from '../../data/codec.js'
import type { Database } from '../../data/schema.js'
import { preserveSqliteSessionGoal } from '../context/sqlite-source.js'
import { sanitizeMediaPayload } from '../context/messages/media.js'
import type { CanonicalRunContext, RunCheckpoint, RunIdentity } from '../models.js'
import type { CompactionPort } from '../ports.js'
import { canonicalBaselineHash, projectDurableHistoryCompaction, reusableHistorySummary, selectHistoryCompactionPrefix,
  summarizeHistoryPrefix, type HistoryCompactionRow, type PreparedHistorySummary } from './history-compaction.js'
import { projectCanonicalRunHistory, type CanonicalRunHistory } from './history-projection.js'
import { enqueueAgentRagRebuildInTransaction } from '../rag/rebuild-worker.js'
import { sqliteAgentRunScope } from './sqlite-store.js'

async function readCompactionRows(connection: Kysely<Database>, session: number, baselineSeq: number) {
  const { rows } = await sql<Omit<HistoryCompactionRow, 'content_json'> & { content_json: string | null }>`
    SELECT CAST(id AS TEXT) AS id,role,content,content_json,coalesce(history_anchor_seq,conversation_seq) AS effective,
      run_id AS runId,round_id AS roundId,CAST(canonical_batch_id AS TEXT) AS canonicalBatchId,covers_until_seq AS coversUntilSeq
    FROM conversation_messages WHERE session_id=${session}
      AND (run_id IS NULL OR run_id NOT LIKE 'im-pending:%')
      AND NOT (role='assistant' AND canonical_batch_id IS NULL AND display_timeline IS NOT NULL
        AND trim(coalesce(content,''))='' AND content_json IS NULL AND (files IS NULL OR files='[]') AND coalesce(quoted_text,'')='')
      AND (role='summary' OR coalesce(history_anchor_seq,conversation_seq) > ${baselineSeq})
    ORDER BY (role<>'summary'),coalesce(history_anchor_seq,conversation_seq), (history_anchor_seq IS NULL),conversation_seq`.execute(connection)
  return rows.map(row => ({
    ...row, content_json: row.content_json === null ? null : JSON.parse(row.content_json),
  }))
}

async function readCompactionScope(connection: Kysely<Database>, identity: RunIdentity, context: CanonicalRunContext) {
  const { owner, session, run } = sqliteAgentRunScope(identity)
  const baseline = context.historyBaseline
  const effect = context.sourceEffects?.sessionSnapshot.state
  if (!baseline || !effect || (!context.compactions?.length && !context.overflowTrimmed)) return null
  const result = await sql<{ anchor: number }>`SELECT m.conversation_seq AS anchor
    FROM conversation_sessions s JOIN agent_run_admissions a ON a.session_id=s.id AND a.user_id=s.user_id AND a.run_id=${run}
    JOIN conversation_messages m ON m.session_id=s.id AND m.id=a.user_message_id AND m.role='user'
    WHERE s.id=${session} AND s.user_id=${owner} AND s.active_run_id=${run}
      AND s.baseline_message_seq=${baseline.baselineSeq} AND s.baseline_message_hash IS ${baseline.baselineHash}
      AND s.snapshot_hash IS ${effect.snapshotHash} AND s.context_epoch=${effect.contextEpoch}`.execute(connection)
  const anchor = result.rows[0]?.anchor
  return anchor === undefined ? null : { session, anchor, baselineSeq: baseline.baselineSeq }
}

/** 摘要请求在 Run 仍获授权时执行，数据库事务内仅重新核对范围和提交。 */
export async function prepareSqliteHistorySummary(
  db: Kysely<Database>, identity: RunIdentity, context: CanonicalRunContext, port: CompactionPort<unknown>, signal: AbortSignal,
): Promise<PreparedHistorySummary | undefined> {
  const plan = await db.transaction().execute(async tx => {
    const scope = await readCompactionScope(tx, identity, context)
    if (!scope) return null
    const rows = await readCompactionRows(tx, scope.session, scope.baselineSeq)
    return selectHistoryCompactionPrefix(rows, scope.baselineSeq, { anchorSeq: scope.anchor, runId: identity.runId })
  })
  if (!plan || reusableHistorySummary(context, plan.covered)) return undefined
  const summary = await summarizeHistoryPrefix(plan, port, signal)
  return summary ? { prefixHash: canonicalBaselineHash(plan.covered), baseline: plan.baseline, previous: plan.previous, summary } : undefined
}

/** 在 RunStore 终态事务中保存续聊批次和用户可见的回复。 */
export async function writeSqliteAgentHistory(
  tx: Transaction<Database>, identity: RunIdentity, history: CanonicalRunHistory, checkpoint: RunCheckpoint<CanonicalRunContext>,
  preparedSummary?: PreparedHistorySummary,
) {
  const projection = projectCanonicalRunHistory(identity, history, checkpoint)
  const { owner, session, run } = sqliteAgentRunScope(identity)
  const { rows } = await sql<{ last_message_seq: number; user_message_id: number; anchor_sequence: number }>`
    SELECT s.last_message_seq,a.user_message_id,m.conversation_seq AS anchor_sequence
    FROM conversation_sessions s
    JOIN agent_run_admissions a ON a.session_id=s.id AND a.user_id=s.user_id AND a.run_id=${run}
    JOIN conversation_messages m ON m.session_id=s.id AND m.id=a.user_message_id AND m.role='user'
    WHERE s.user_id=${owner} AND s.id=${session} AND s.active_run_id=${run}`.execute(tx)
  const current = rows[0]
  if (!current || String(current.user_message_id) !== projection.anchorEntry?.persistedMessageId)
    throw new Error('Agent 历史锚点不存在或不匹配')
  const at = databaseTime(nowUtc(), 'sqlite')
  await sql`INSERT INTO conversation_batches(session_id,version,run_id,round_id,digest,created_at)
    VALUES(${session},'finalize-v1',${run},'round-1',${projection.receipt},${at})`.execute(tx)
  const cache = history.context.providerCacheAnchor
  if (cache && (history.outcome === 'success' || history.outcome === 'silent')
    && !history.context.compactions.length && !history.context.overflowTrimmed)
    await sql`UPDATE conversation_sessions
      SET session_context=json_set(coalesce(session_context,'{}'),'$.provider_cache_anchor',json(${JSON.stringify(cache.anchor)}))
      WHERE id=${session} AND user_id=${owner} AND active_run_id=${run}`.execute(tx)
  if (history.outcome === 'silent') return

  await sql`UPDATE conversation_messages SET run_id=${run},round_id='round-1',run_outcome=${projection.outcome}
    WHERE session_id=${session} AND id=${current.user_message_id}`.execute(tx)
  let sequence = current.last_message_seq
  const compactionScope = history.outcome === 'success' ? await readCompactionScope(tx, identity, history.context) : null
  const compacted = compactionScope ? projectDurableHistoryCompaction(history.context,
    await readCompactionRows(tx, session, compactionScope.baselineSeq), compactionScope.anchor, preparedSummary) : null
  const total = projection.delta.entries.length + Number(projection.display !== null) + Number(compacted !== null)
  if (!Number.isSafeInteger(sequence) || sequence < 0 || !Number.isSafeInteger(sequence + total))
    throw new Error('Agent 会话序号无效')

  if (compacted) {
    await sql`DELETE FROM conversation_messages WHERE session_id=${session} AND role='summary'`.execute(tx)
    await sql`INSERT INTO conversation_messages(session_id,conversation_seq,role,content,covers_until_seq,created_at)
      VALUES(${session},${++sequence},'summary',${compacted.summary},${compacted.baseline},${at})`.execute(tx)
    const state = compacted.snapshot
    const snapshot = await preserveSqliteSessionGoal(tx, owner, session, state.context)
    const expires = state.snapshotExpiresAt === null ? null : databaseTime(new Date(state.snapshotExpiresAt).toISOString(), 'sqlite')
    await sql`UPDATE conversation_sessions SET baseline_message_seq=${compacted.baseline},baseline_message_hash=${compacted.hash},
      session_context=${JSON.stringify(snapshot)},context_epoch=${state.contextEpoch},snapshot_hash=${state.snapshotHash},
      session_info_hash=${state.sessionInfoHash},snapshot_expires_at=${expires} WHERE id=${session} AND user_id=${owner}`.execute(tx)
  }

  const userSequence = projection.delta.userAnchorSequence
  for (const group of projection.batches) {
    const batch = await sql<{ id: number }>`INSERT INTO conversation_batches(session_id,version,run_id,round_id,digest,created_at)
      VALUES(${session},'v1',${run},${group.round},${group.digest},${at}) RETURNING id`.execute(tx)
    for (const entry of group.entries) {
      const value = sanitizeMediaPayload(entry.message.content)
      const anchor = userSequence !== null && entry.sequence < userSequence ? current.anchor_sequence : null
      await sql`INSERT INTO conversation_messages(session_id,conversation_seq,history_anchor_seq,role,content,content_json,
        canonical_batch_id,run_id,round_id,created_at,sent_at)
        VALUES(${session},${++sequence},${anchor},${entry.message.role},${typeof value === 'string' ? value : ''},
          ${typeof value === 'string' ? null : JSON.stringify(value)},${batch.rows[0]!.id},${run},${entry.roundId || 'round-1'},${at},${at})`.execute(tx)
    }
  }
  const display = projection.display
  if (display) await sql`INSERT INTO conversation_messages(session_id,conversation_seq,role,content,files,display_timeline,
    run_id,round_id,created_at,sent_at)
    VALUES(${session},${++sequence},'assistant',${display.text},${display.files},${display.timeline},${run},${display.roundId},${at},${at})`.execute(tx)
  if (total) {
    await sql`UPDATE conversation_sessions SET last_message_seq=${sequence},updated_at=${at}
      WHERE id=${session} AND user_id=${owner}`.execute(tx)
    await enqueueAgentRagRebuildInTransaction(tx, 'sqlite', identity.ownerId, 'conversation')
  }
}
