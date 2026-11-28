import { coveredReflectionPrefix, PRIVATE_REFLECTION_IDLE_SECONDS, qualifiesReflectionTurn } from '@gugu/core/agent/memory/reflection/window'
import { parseCompactionReflectionEdits, type CompactionReflectionEdits } from '@gugu/core/agent/memory/owner-reflection-edits'
import { createHash, randomUUID } from 'node:crypto'
import type { RunIdentity } from '@gugu/core/agent'
import type { Pool, PoolClient } from 'pg'
import { decryptEncryptedString, encryptEncryptedString } from '../../../../adapters/security/encrypted-string.js'
import type { PrepareCompactedReflection } from '../../chat/compact.js'
import { withPostgresTransaction } from '../../../../adapters/database/postgres-transaction.js'
import type { AgentReflectionTurn } from './queue.js'
import type { createReflectionModelScope } from '../../llm/recovery.js'

type Anchor = Pick<AgentReflectionTurn, 'userMessageId' | 'modelIdentity' | 'accessScopeHash'> & {
  runId: string
  modelScope: string
  seq: string
  timestamp: number
  compactionCandidate?: string
}
type Interval = {
  session_id: number
  user_id: string
  pending: Anchor[]
  frozen: Anchor[]
  batch_limit: number
  compaction_through: string | null
  idle_due: boolean
}

export async function hasPrivateReflectionLedger(client: Pick<PoolClient, 'query'>) {
  const { rows: [schema] } = await client.query<{ available: boolean }>(
    "SELECT to_regclass('web_reflection_intervals') IS NOT NULL AS available")
  return schema?.available === true
}

/** 在回复提交事务中从已接受的私聊回合推进闲置期限，重放不延长期限。 */
export async function observePrivateReflectionTurn(
  client: Pick<PoolClient, 'query'>, identity: RunIdentity, through: number,
): Promise<string | null> {
  if (!await hasPrivateReflectionLedger(client)) return null
  const { rows: [window] } = await client.query<{ due: string }>(`
    INSERT INTO web_reflection_intervals(session_id,user_id,observed_through,completed_through,idle_due_at)
    SELECT s.id,s.user_id,$3,0,clock_timestamp()+$4*interval '1 second'
    FROM conversation_sessions s WHERE s.id=$1 AND s.user_id=$2 AND s.chat_type='c2c'
    ON CONFLICT(session_id) DO UPDATE SET
      idle_due_at=CASE WHEN excluded.observed_through>web_reflection_intervals.observed_through
        THEN greatest(web_reflection_intervals.idle_due_at,excluded.idle_due_at)
        ELSE web_reflection_intervals.idle_due_at END,
      observed_through=greatest(web_reflection_intervals.observed_through,excluded.observed_through)
    WHERE web_reflection_intervals.user_id=excluded.user_id
    RETURNING idle_due_at::text AS due
  `, [identity.sessionId, identity.ownerId, through, PRIVATE_REFLECTION_IDLE_SECONDS])
  if (!window) throw new Error('私聊反思闲置区间登记失败')
  return window.due
}

/** 在现有任务授权后冻结其回合范围。重领时只能接手同一范围。 */
export async function freezePrivateReflectionWindow(
  client: Pick<PoolClient, 'query'>, identity: RunIdentity,
  jobId: string, token: string, after: number, through: number,
): Promise<boolean> {
  if (!await hasPrivateReflectionLedger(client)) return true
  const range = JSON.stringify([{ jobId, after, through }])
  const updated = await client.query(`
    INSERT INTO web_reflection_intervals(session_id,user_id,observed_through,idle_due_at,frozen,lease_token,lease_until)
    SELECT s.id,s.user_id,$5,clock_timestamp(),$6::jsonb,j.token,j.lease_until
    FROM conversation_sessions s JOIN gugu_im_reflection_jobs j ON j.session_id=s.id AND j.user_id=s.user_id
    WHERE s.id=$1 AND s.user_id=$2 AND s.chat_type='c2c' AND j.id=$3 AND j.token=$4
      AND j.lease_until>clock_timestamp()
    ON CONFLICT(session_id) DO UPDATE SET
      frozen=excluded.frozen,lease_token=excluded.lease_token,lease_until=excluded.lease_until,retry_at=NULL
    WHERE web_reflection_intervals.user_id=excluded.user_id AND (
      web_reflection_intervals.frozen='[]'::jsonb OR web_reflection_intervals.frozen=excluded.frozen
      OR NOT EXISTS (
        SELECT 1 FROM gugu_im_reflection_jobs old
        WHERE old.id::text=(web_reflection_intervals.frozen->0->>'jobId')
          AND old.user_id=excluded.user_id AND old.session_id=excluded.session_id
          AND old.state NOT IN ('completed','cancelled','dead')
      )
    )
  `, [identity.sessionId, identity.ownerId, jobId, token, through, range])
  return updated.rowCount === 1
}

export async function settlePrivateReflectionWindow(
  client: Pick<PoolClient, 'query'>, identity: RunIdentity, jobId: string, token: string, retryAt: Date | null,
) {
  if (!await hasPrivateReflectionLedger(client)) return
  await client.query(`
    UPDATE web_reflection_intervals SET
      frozen=CASE WHEN $5::timestamptz IS NULL THEN '[]'::jsonb ELSE frozen END,
      retry_at=$5,lease_token=NULL,lease_until=NULL
    WHERE session_id=$1 AND user_id=$2 AND frozen->0->>'jobId'=$3 AND lease_token=$4
  `, [identity.sessionId, identity.ownerId, jobId, token, retryAt])
}

/** IM 在文件计划成功后，同事务登记私聊的已处理水位。 */
export async function recordPrivateReflectionCompletion(
  client: Pick<PoolClient, 'query'>, identity: RunIdentity, through: number,
) {
  if (!await hasPrivateReflectionLedger(client)) return
  const result = await client.query(`
    INSERT INTO web_reflection_intervals(session_id,user_id,observed_through,completed_through,idle_due_at)
    SELECT s.id,s.user_id,$3,$3,clock_timestamp() FROM conversation_sessions s
    WHERE s.id=$1 AND s.user_id=$2 AND s.chat_type='c2c'
    ON CONFLICT(session_id) DO UPDATE SET
      observed_through=greatest(web_reflection_intervals.observed_through,excluded.observed_through),
      completed_through=greatest(web_reflection_intervals.completed_through,excluded.completed_through)
    WHERE web_reflection_intervals.user_id=excluded.user_id
  `, [identity.sessionId, identity.ownerId, through])
  if (result.rowCount !== 1) throw new Error('私聊反思水位提交失败')
}

/** 清除前冻结已入库的消息水位，拦住清除前启动、稍后才收尾的 Run。 */
export async function clearWebReflectionIntervals(pool: Pick<Pool, 'query'>, ownerId: string) {
  const { rows: [schema] } = await pool.query<{ available: boolean; compaction: boolean }>(`
    SELECT to_regclass('web_reflection_intervals') IS NOT NULL AS available,
      EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('web_reflection_intervals')
        AND attname='compaction_through' AND NOT attisdropped) AS compaction
  `)
  if (!schema?.available) return
  await pool.query(`
    INSERT INTO web_reflection_intervals(session_id,user_id,observed_through,idle_due_at)
    SELECT id,user_id,last_message_seq,clock_timestamp() FROM conversation_sessions
    WHERE user_id=$1 AND source='web' AND (chat_type IS NULL OR chat_type='private')
    ON CONFLICT(session_id) DO UPDATE SET
      observed_through=greatest(web_reflection_intervals.observed_through,excluded.observed_through),
      pending='[]'::jsonb,frozen='[]'::jsonb,batch_limit=100,
      ${schema.compaction ? 'compaction_through=NULL,' : ''}
      retry_at=NULL,lease_token=NULL,lease_until=NULL
    WHERE web_reflection_intervals.user_id=excluded.user_id
  `, [ownerId])
}

export function createPostgresWebReflectionIntervals(options: {
  pool: Pick<Pool, 'query' | 'connect'>
  modelScope: ReturnType<typeof createReflectionModelScope>
  now?: () => Date
  compactionEnabled?: boolean
  secretKey?: string
}) {
  const { pool } = options
  const now = options.now ?? (() => new Date())
  const compactionEnabled = options.compactionEnabled ?? true

  async function enqueue(input: AgentReflectionTurn): Promise<boolean> {
    if (!qualifiesReflectionTurn(input)) return false
    const { ownerId, sessionId, runId } = input.identity
    const modelScope = options.modelScope(input.identity, input)
    const result = await pool.query(`
      INSERT INTO web_reflection_intervals(session_id,user_id,observed_through,pending,idle_due_at)
      SELECT s.id,s.user_id,m.conversation_seq,jsonb_build_array(jsonb_build_object(
        'userMessageId',m.id::text,'seq',m.conversation_seq::text,'runId',m.run_id,
        'modelIdentity',$5::text,'accessScopeHash',$6::text,'modelScope',$7::text,
        'timestamp',extract(epoch FROM $8::timestamptz)
      )),$8::timestamptz+$9*interval '1 second'
      FROM conversation_sessions s JOIN conversation_messages m ON m.session_id=s.id
      WHERE s.id=$1 AND s.user_id=$2 AND s.source='web' AND (s.chat_type IS NULL OR s.chat_type='private')
        AND m.id=$3 AND m.run_id=$4 AND m.role='user'
      ON CONFLICT(session_id) DO UPDATE SET
        observed_through=excluded.observed_through,
        pending=web_reflection_intervals.pending || excluded.pending,
        idle_due_at=greatest(web_reflection_intervals.idle_due_at,excluded.idle_due_at)
      WHERE web_reflection_intervals.user_id=excluded.user_id
        AND web_reflection_intervals.observed_through<excluded.observed_through
    `, [sessionId, ownerId, input.userMessageId, runId, input.modelIdentity, input.accessScopeHash, modelScope, now(), PRIVATE_REFLECTION_IDLE_SECONDS])
    return result.rowCount === 1
  }

  async function stageCompaction(client: Pick<PoolClient, 'query'>, identity: RunIdentity, coveredUserIds: readonly string[]) {
    if (!compactionEnabled || !coveredUserIds.length) return
    // 只推进连续的待处理前缀，已被冻结的窗口与其重试时间均由领取者管理。
    await client.query(`
      WITH locked AS MATERIALIZED (
        SELECT session_id,pending FROM web_reflection_intervals WHERE session_id=$1 AND user_id=$2 FOR UPDATE
      ), covered AS (
        SELECT i.session_id, max((anchor->>'seq')::bigint) AS through
        FROM locked i
        CROSS JOIN LATERAL (
          SELECT anchor,
            bool_and(anchor->>'userMessageId'=ANY($3::text[])) OVER (ORDER BY ord) AS contiguous
          FROM jsonb_array_elements(i.pending) WITH ORDINALITY AS turns(anchor,ord)
        ) AS candidates
        WHERE candidates.contiguous
        GROUP BY i.session_id
      )
      UPDATE web_reflection_intervals i SET compaction_through=greatest(i.compaction_through,covered.through)
      FROM covered WHERE i.session_id=covered.session_id AND i.user_id=$2 AND (
        i.compaction_through IS NULL OR i.compaction_through<covered.through
      )
    `, [identity.sessionId, identity.ownerId, coveredUserIds])
  }

  const prepareCompaction: PrepareCompactedReflection = async (identity, coveredUserIds) => {
    const secret = options.secretKey
    if (!secret || !compactionEnabled || !coveredUserIds.length) return null
    const { rows: [row] } = await pool.query<Pick<Interval, 'pending' | 'batch_limit'>>(`
      SELECT pending,batch_limit FROM web_reflection_intervals
      WHERE session_id=$1 AND user_id=$2 AND frozen='[]'::jsonb
    `, [identity.sessionId, identity.ownerId])
    if (!row || row.pending[0]?.compactionCandidate) return null
    const prefix = coveredReflectionPrefix(row.pending, coveredUserIds, anchor => [anchor.userMessageId])
    const boundary = prefix.findIndex(anchor => anchor.modelScope !== prefix[0]?.modelScope)
    const turns = prefix.slice(0, Math.min(row.batch_limit, boundary < 0 ? prefix.length : boundary))
    if (!turns.length) return null
    const userIds = turns.map(turn => turn.userMessageId)
    return {
      userIds,
      async stage(client, candidate, evidence) {
        const output = parseCompactionReflectionEdits(candidate)
        if (!output) return
        const sealed = encryptEncryptedString(secret, JSON.stringify({
          owner: identity.ownerId, session: identity.sessionId, ids: userIds, output, evidence,
        }))
        await client.query(`
          UPDATE web_reflection_intervals SET pending=jsonb_set(pending,'{0,compactionCandidate}',to_jsonb($4::text),true)
          WHERE session_id=$1 AND user_id=$2 AND frozen='[]'::jsonb
            AND NOT ((pending->0) ? 'compactionCandidate')
            AND (SELECT jsonb_agg(value ORDER BY ord) FROM jsonb_array_elements(pending) WITH ORDINALITY AS a(value,ord)
                 WHERE ord<=jsonb_array_length($3::jsonb))=$3::jsonb
        `, [identity.sessionId, identity.ownerId, JSON.stringify(turns), sealed])
      },
    }
  }

  async function claim() {
    const token = randomUUID()
    const at = now()
    const batch = await withPostgresTransaction(pool, async client => {
      const { rows: [row] } = await client.query<Interval>(`
        SELECT i.session_id,i.user_id,i.pending,i.frozen,i.batch_limit, i.idle_due_at<=$1 AS idle_due,
          ${compactionEnabled ? "i.compaction_through::text" : "NULL"} AS compaction_through
        FROM web_reflection_intervals i
        JOIN conversation_sessions s ON s.id=i.session_id AND s.user_id=i.user_id
        JOIN users u ON u.id=i.user_id
        WHERE u.is_active IS TRUE AND coalesce(u.account_status,'active')='active'
          AND s.source='web' AND (s.chat_type IS NULL OR s.chat_type='private')
          AND s.execution_state='idle' AND s.active_run_id IS NULL AND s.pending_message_count=0
          AND ((i.frozen='[]'::jsonb AND i.pending<>'[]'::jsonb AND
            (i.idle_due_at<=$1 ${compactionEnabled ? 'OR i.compaction_through IS NOT NULL' : ''}))
            OR (i.frozen<>'[]'::jsonb AND i.retry_at<=$1))
          AND NOT EXISTS (SELECT 1 FROM web_reflection_intervals live
            WHERE live.user_id=i.user_id AND live.lease_until>$1)
        ORDER BY coalesce(i.retry_at,i.idle_due_at),i.session_id
        LIMIT 1 FOR UPDATE OF i,u SKIP LOCKED
      `, [at])
      if (!row) return null
      // 按到期的闲置窗口或压缩覆盖前缀冻结。一次调用只读取同模型作用域的一段。
      const starting = !row.frozen.length
      const frozen = !starting ? row.frozen : row.idle_due ? row.pending
        : row.pending.filter(anchor => BigInt(anchor.seq) <= BigInt(row.compaction_through!))
      if (!frozen.length) return null
      const first = frozen[0]!
      const candidates = frozen.slice(0, row.batch_limit)
      const boundary = candidates.findIndex(turn => turn.modelScope !== first.modelScope)
      const turns = boundary < 0 ? candidates : candidates.slice(0, boundary)
      await client.query(`UPDATE web_reflection_intervals SET frozen=$2::jsonb,
        pending=$5::jsonb,
        ${compactionEnabled ? "compaction_through=CASE WHEN frozen='[]'::jsonb THEN NULL ELSE compaction_through END," : ''}
        retry_at=$3,lease_token=$4,lease_until=$3::timestamptz+interval '3 minutes'
        WHERE session_id=$1`, [row.session_id, JSON.stringify(frozen), at, token,
        JSON.stringify(starting ? row.pending.slice(frozen.length) : row.pending)])
      return { row, turns }
    })
    if (!batch) return null
    const { row, turns } = batch
    const { user_id: ownerId, session_id: session } = row
    const sessionId = String(session)
    const batchId = createHash('sha256').update(JSON.stringify([ownerId, sessionId, turns.map(turn => [turn.seq, turn.runId])])).digest('hex')

    async function settle(action: 'complete' | 'split' | 'retry', delayMs = 0) {
      if (!Number.isSafeInteger(delayMs) || delayMs < 0) throw new RangeError('反思重试间隔无效')
      const time = now()
      // 按有序下标截取，保留同一冻结窗口中的剩余回合。
      const assignment = action === 'complete'
        ? `frozen=coalesce((SELECT jsonb_agg(value ORDER BY ord) FROM jsonb_array_elements(frozen)
             WITH ORDINALITY AS anchor(value,ord) WHERE ord>$5),'[]'::jsonb),
             completed_through=$6,batch_limit=100`
        : 'batch_limit=$5'
      const parameters = action === 'complete'
        ? [session, token, time, new Date(time.getTime() + delayMs), turns.length, turns.at(-1)!.seq]
        : [session, token, time, new Date(time.getTime() + delayMs), action === 'split' ? Math.floor(turns.length / 2) : row.batch_limit]
      const result = await pool.query(`UPDATE web_reflection_intervals SET ${assignment},
        retry_at=CASE WHEN ${action === 'complete' ? 'jsonb_array_length(frozen)=$5' : 'false'} THEN NULL ELSE $4::timestamptz END,
        lease_token=NULL,lease_until=NULL
        WHERE session_id=$1 AND lease_token=$2 AND lease_until>$3`, parameters)
      return result.rowCount === 1
    }
    let compactionCandidate: { output: CompactionReflectionEdits; evidence: string } | undefined
    const sealed = turns[0]?.compactionCandidate
    if (sealed?.startsWith('gcm1:') && options.secretKey) {
      try {
        const value = JSON.parse(decryptEncryptedString(options.secretKey, sealed))
        const output = parseCompactionReflectionEdits(value.output ?? { daily: value.daily })
        if (output && value.owner === ownerId && value.session === sessionId
          && JSON.stringify(value.ids) === JSON.stringify(turns.map(turn => turn.userMessageId))
          && typeof value.evidence === 'string')
          compactionCandidate = { output, evidence: value.evidence }
      } catch { /* 损坏或失效的候选由原区间反思流程重试。 */ }
    }
    return {
      ownerId, sessionId, batchId, turns, compactionCandidate,
      async isCurrent() {
        const result = await pool.query('SELECT 1 FROM web_reflection_intervals WHERE session_id=$1 AND lease_token=$2 AND lease_until>$3', [session, token, now()])
        return result.rowCount === 1
      },
      complete: () => settle('complete'),
      split: () => turns.length > 1 ? settle('split') : Promise.resolve(false),
      retry: (delayMs: number) => settle('retry', delayMs),
    }
  }

  return { enqueue, claim, stageCompaction, prepareCompaction }
}
