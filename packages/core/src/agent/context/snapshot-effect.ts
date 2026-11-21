import type { CanonicalRunContext, RunIdentity } from '../models.js'

export function requireCanonicalSnapshotEffect(identity: RunIdentity, context: CanonicalRunContext) {
  const effect = context.sourceEffects?.sessionSnapshot
  const baseline = context.historyBaseline
  if (!effect || !baseline || effect.expectedSnapshotHash === undefined
    || effect.expectedSnapshotHash !== baseline.snapshotHash
    || effect.state.baselineMessageSeq !== baseline.baselineSeq
    || context.identity.ownerId !== identity.ownerId || context.identity.sessionId !== identity.sessionId
    || context.identity.runId !== identity.runId || effect.state.ownerId !== identity.ownerId || effect.state.sessionId !== identity.sessionId)
    throw new Error('会话快照来源身份无效')
  return { effect, baseline }
}
