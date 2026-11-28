import { AgentRunError } from '../models.js'
import type { ProviderCursor, ProviderRecoveryBoundary, SanitizerCheckpoint } from '../models.js'
import type { StreamSanitizer } from '../ports.js'

export function reference(value: string): boolean { return /^[A-Za-z0-9_.:-]{1,256}$/.test(value) }

export function snapshotCursor(value: ProviderCursor): ProviderCursor {
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1 || (value.reference !== null && (typeof value.reference !== 'string' || !reference(value.reference))))
    throw new AgentRunError('invalid_state', '模型流游标无效')
  return Object.freeze({ sequence: value.sequence, reference: value.reference })
}

export function sanitizerCheckpoint(sanitizer: StreamSanitizer): SanitizerCheckpoint {
  const value = sanitizer.checkpoint?.() ?? { kind: 'unavailable' as const }
  if (value.kind === 'reference' && !reference(value.reference))
    throw new AgentRunError('invalid_state', '清洗器状态引用无效')
  if (!['clean', 'unavailable', 'reference'].includes(value.kind))
    throw new AgentRunError('invalid_state', '清洗器恢复状态无效')
  return value.kind === 'reference' ? Object.freeze({ kind: 'reference', reference: value.reference }) : Object.freeze({ kind: value.kind })
}

export function sameRecoveryBoundary(left: ProviderRecoveryBoundary, right: ProviderRecoveryBoundary): boolean {
  return left.identity.ownerId === right.identity.ownerId && left.identity.sessionId === right.identity.sessionId && left.identity.runId === right.identity.runId
    && left.round === right.round && left.runSequence === right.runSequence && left.roundText === right.roundText
    && left.cursor?.sequence === right.cursor?.sequence && left.cursor?.reference === right.cursor?.reference
    && left.sanitizer.kind === right.sanitizer.kind
    && (left.sanitizer.kind !== 'reference' || right.sanitizer.kind === 'reference' && left.sanitizer.reference === right.sanitizer.reference)
}
