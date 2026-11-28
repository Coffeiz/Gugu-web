import type { PoolClient } from 'pg'
import { requireCanonicalSnapshotEffect } from '@gugu/core/agent'
import type { CanonicalRunContext, RunIdentity } from '@gugu/core/agent'

/** 快照与历史压缩均保留数据库当前的目标控制字段。 */
export const sessionSnapshotContextSql = `($5::jsonb - ARRAY['goal_text','goal_status','goal_mode'])
       || json_strip_nulls(json_build_object('goal_text', session_context::jsonb->'goal_text',
         'goal_status', session_context::jsonb->'goal_status', 'goal_mode', session_context::jsonb->'goal_mode'))::jsonb`

/** 与首次 prepared checkpoint 同事务执行；任何身份或并发冲突都回滚整个提交。 */
export async function applyCanonicalSnapshotEffects(client: PoolClient, identity: RunIdentity, context: CanonicalRunContext): Promise<void> {
  const { effect, baseline } = requireCanonicalSnapshotEffect(identity, context)
  const state = effect.state
  const result = await client.query(
    `UPDATE conversation_sessions SET session_context = ${sessionSnapshotContextSql},
       context_epoch = $6,
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
