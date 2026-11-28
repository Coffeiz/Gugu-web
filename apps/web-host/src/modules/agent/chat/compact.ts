import { sessionSnapshotContextSql } from '../context/effects.js'
import { buildCompactionReflectionTask } from '@gugu/core/agent/memory/reflection/window'
import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import {
  contentText, emergencyHistorySummary, formatCompactedSummary, historyCompactionMessages,
  reusableHistorySummary, selectHistoryCompactionPrefix, stableJson, updateBaselineSnapshot, validateCompactSummary,
} from '@gugu/core/agent'
import type { CanonicalRunContext, CompactionPort, Json, RunIdentity } from '@gugu/core/agent'
import { lockCanonicalHistoryBaseline } from './baseline.js'
import { canonicalBaselineHash } from './write.js'
import { enqueuePostgresAgentRagRebuild } from '../rag/jobs.js'

type HistoryRow = {
  id: string
  role: string
  content: string
  content_json: Json
  effective: string
  runId: string | null
  roundId: string | null
  canonicalBatchId: string | null
  coversUntilSeq: string | null
}

async function readHistory(db: Pick<Pool, 'query'> | PoolClient, context: CanonicalRunContext, anchorId: number) {
  const { identity, historyBaseline } = context
  return (await db.query<HistoryRow>(`
    SELECT m.id::text, m.role, m.content, m.content_json,
      coalesce(m.history_anchor_seq, m.conversation_seq)::text AS effective,
      m.run_id AS "runId", m.round_id AS "roundId", m.canonical_batch_id::text AS "canonicalBatchId", m.covers_until_seq::text AS "coversUntilSeq"
    FROM conversation_sessions s JOIN conversation_messages m ON m.session_id=s.id
    WHERE s.id=$1 AND s.user_id=$2 AND s.baseline_message_seq=$3 AND (
      m.role='summary' OR (
        coalesce(m.history_anchor_seq,m.conversation_seq)>$3 AND
        coalesce(m.history_anchor_seq,m.conversation_seq)<(
          SELECT a.conversation_seq FROM conversation_messages a
          WHERE a.session_id=s.id AND a.id=$4 AND a.role='user'
        ) AND (m.run_id IS NULL OR m.run_id NOT LIKE 'im-pending:%')
        AND NOT (m.role='assistant' AND m.canonical_batch_id IS NULL AND m.display_timeline IS NOT NULL
          AND btrim(coalesce(m.content,''))='' AND m.content_json IS NULL
          AND (m.files IS NULL OR m.files='[]'::jsonb) AND coalesce(m.quoted_text,'')='')
      ))
    ORDER BY (m.role<>'summary'), coalesce(m.history_anchor_seq,m.conversation_seq),
      (m.history_anchor_seq IS NULL),m.conversation_seq
  `, [identity.sessionId, identity.ownerId, historyBaseline!.baselineSeq, anchorId])).rows
}

export type StageCompactedReflection = (client: PoolClient, identity: RunIdentity, coveredUserIds: readonly string[]) => Promise<void>

export type PrepareCompactedReflection = (identity: RunIdentity, coveredUserIds: readonly string[]) => Promise<{
  userIds: readonly string[]
  stage(client: PoolClient, candidate: { [key: string]: Json }, evidence: string): Promise<void>
} | null>

function coveredReflectionAnchors(covered: readonly HistoryRow[]): string[] {
  const completedRuns = new Set(covered.filter(row => row.role === 'assistant' && row.canonicalBatchId === null
    && row.runId && contentText(row.content_json ?? row.content).trim()).map(row => row.runId))
  return covered.filter(row => row.role === 'user' && row.runId && completedRuns.has(row.runId)).map(row => row.id)
}

/** 回复提交后复用可证明覆盖同一前缀的摘要，否则从已提交历史重新生成。 */
export async function persistRunCompaction<Wire>(pool: Pick<Pool, 'query' | 'connect'>, context: CanonicalRunContext, port: CompactionPort<Wire>, anchorId: number,
  authorize: () => Promise<boolean> = async () => true, stageReflection?: StageCompactedReflection, prepareReflection?: PrepareCompactedReflection) {
  const originalSnapshot = context.sourceEffects?.sessionSnapshot.state
  const latest = context.compactions.at(-1)
  if (!context.historyBaseline || !originalSnapshot || (!latest?.result.changed && !context.overflowTrimmed) || !await authorize()) return false
  const { identity } = context
  const rows = await readHistory(pool, context, anchorId)
  const plan = selectHistoryCompactionPrefix(rows, context.historyBaseline.baselineSeq, { runId: identity.runId })
  if (!plan) return false
  const { covered, baseline, previous } = plan
  let summary = reusableHistorySummary(context, covered)
  const anchors = coveredReflectionAnchors(covered)
  const reflection = await prepareReflection?.(identity, anchors)
  let evidence = ''
  let memoryCandidate: { [key: string]: Json } | undefined
  if (!validateCompactSummary(summary) || reflection) {
    const messages = historyCompactionMessages(covered)
    if (!messages.length) return false
    const signal = AbortSignal.timeout(90_000)
    const byId = new Map(covered.map(row => [row.id, row]))
    const replies = new Map(covered.filter(row => row.role === 'assistant' && row.canonicalBatchId === null)
      .map(row => [row.runId, row.content]))
    const turns = reflection?.userIds.map(id => {
      const user = byId.get(id)
      return [user?.content ?? '', replies.get(user?.runId ?? null) ?? ''] as const
    })
    if (turns) evidence = createHash('sha256').update(JSON.stringify(turns)).digest('hex')
    const generated = await port.summarize({
      history: messages, compressible: messages, requestPrefix: [], projection: null,
      previousSummary: previous ? formatCompactedSummary(previous) : null, preserveLatestUser: false,
      ...(reflection ? { reflection: {
        task: buildCompactionReflectionTask(turns ?? []),
        receive(candidate: { [key: string]: Json }) { memoryCandidate = candidate },
      } } : {}),
    }, signal)
    if (!validateCompactSummary(summary) && validateCompactSummary(generated)) summary = generated
    if (!validateCompactSummary(summary)) {
      summary = emergencyHistorySummary(messages, previous)
    }
  }
  if (!validateCompactSummary(summary) || !await authorize()) return false

  const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')
  const snapshot = updateBaselineSnapshot(originalSnapshot, [{ role: 'summary', content: summary }],
    { digest, nextId: randomUUID, now: Date.now }, { baselineMessageSeq: baseline })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (!await lockCanonicalHistoryBaseline(client, identity, context) || stableJson(await readHistory(client, context, anchorId)) !== stableJson(rows)) {
      await client.query('ROLLBACK')
      return false
    }
    await client.query("DELETE FROM conversation_messages WHERE session_id=$1 AND role='summary'", [identity.sessionId])
    await client.query(`UPDATE conversation_sessions SET last_message_seq=last_message_seq+1, baseline_message_seq=$3,
      baseline_message_hash=$4, session_context=${sessionSnapshotContextSql}, context_epoch=$6, snapshot_hash=$7,
      session_info_hash=$8, snapshot_expires_at=$9 WHERE id=$1 AND user_id=$2`,
    [identity.sessionId, identity.ownerId, baseline, canonicalBaselineHash(covered), JSON.stringify(snapshot.context),
      snapshot.contextEpoch, snapshot.snapshotHash, snapshot.sessionInfoHash,
      snapshot.snapshotExpiresAt === null ? null : new Date(snapshot.snapshotExpiresAt)])
    await client.query(`INSERT INTO conversation_messages (session_id,conversation_seq,role,content,covers_until_seq,created_at)
      SELECT id,last_message_seq,'summary',$3,$4,clock_timestamp() FROM conversation_sessions WHERE id=$1 AND user_id=$2`,
    [identity.sessionId, identity.ownerId, summary, baseline])
    await stageReflection?.(client, identity, anchors)
    if (reflection && memoryCandidate) await reflection.stage(client, memoryCandidate, evidence)
    await enqueuePostgresAgentRagRebuild(client, identity.ownerId, 'conversation')
    await client.query('COMMIT')
    return true
  }
  catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
  finally {
    client.release()
  }
}
