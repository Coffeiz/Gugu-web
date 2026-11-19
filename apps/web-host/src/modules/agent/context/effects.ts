import type { PoolClient } from 'pg'
import type { CanonicalRunContext, RunIdentity } from '@gugu/core/agent'

/** 与首次 prepared checkpoint 同事务执行；任何身份或并发冲突都回滚整个提交。 */
export async function applyCanonicalSnapshotEffects(client: PoolClient, identity: RunIdentity, context: CanonicalRunContext): Promise<void> {
  const effect = context.sourceEffects?.sessionSnapshot
  const baseline = context.historyBaseline
  if (!effect || !baseline || effect.expectedSnapshotHash === undefined
    || effect.expectedSnapshotHash !== baseline.snapshotHash
    || effect.state.baselineMessageSeq !== baseline.baselineSeq
    || context.identity.ownerId !== identity.ownerId || context.identity.sessionId !== identity.sessionId
    || context.identity.runId !== identity.runId || effect.state.ownerId !== identity.ownerId || effect.state.sessionId !== identity.sessionId)
    throw new Error('会话快照来源身份无效')
  const state = effect.state
  const result = await client.query(
    `UPDATE conversation_sessions SET session_context = $5::jsonb, context_epoch = $6,
       snapshot_hash = $7, session_info_hash = $8, snapshot_expires_at = $9
     WHERE user_id = $1 AND id = $2 AND context_epoch = $3 AND snapshot_hash IS NOT DISTINCT FROM $4
       AND baseline_message_seq = $10 AND baseline_message_hash IS NOT DISTINCT FROM $11`,
    [identity.ownerId, identity.sessionId, effect.expectedEpoch, effect.expectedSnapshotHash,
      state.context === null ? null : JSON.stringify(state.context), state.contextEpoch, state.snapshotHash,
      state.sessionInfoHash, state.snapshotExpiresAt === null ? null : new Date(state.snapshotExpiresAt),
      baseline.baselineSeq, baseline.baselineHash],
  )
  if (result.rowCount !== 1) throw new Error('会话快照已变化，拒绝提交')
}
