import type { PoolClient } from 'pg'
import type { CanonicalRunContext, RunIdentity } from '@gugu/core/agent'

/** 在调用方事务中锁住会话并校验压缩读取视图；事务提交前不得释放锁。 */
export async function lockCanonicalHistoryBaseline(
  client: PoolClient,
  identity: RunIdentity,
  context: CanonicalRunContext,
): Promise<boolean> {
  const baseline = context.historyBaseline
  if (!baseline || context.identity.ownerId !== identity.ownerId || context.identity.sessionId !== identity.sessionId
    || context.identity.runId !== identity.runId)
    throw new Error('历史基线身份缺失或不匹配')
  const expectedSnapshot = context.sourceEffects ? context.sourceEffects.sessionSnapshot.state.snapshotHash : baseline.snapshotHash
  const expectedEpoch = context.sourceEffects?.sessionSnapshot.state.contextEpoch
  const result = await client.query<{ baseline: string; baseline_hash: string | null; snapshot_hash: string | null; context_epoch: number }>(
    `SELECT baseline_message_seq::text AS baseline, baseline_message_hash AS baseline_hash, snapshot_hash, context_epoch
       FROM conversation_sessions WHERE user_id = $1 AND id = $2 FOR UPDATE`,
    [identity.ownerId, identity.sessionId],
  )
  const current = result.rows[0]
  if (!current) throw new Error('Agent 会话不存在')
  return Number(current.baseline) === baseline.baselineSeq && current.baseline_hash === baseline.baselineHash
    && current.snapshot_hash === expectedSnapshot && (expectedEpoch == null || current.context_epoch === expectedEpoch)
}
