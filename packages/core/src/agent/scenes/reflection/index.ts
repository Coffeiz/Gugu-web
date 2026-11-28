import { compileContextFragments } from '../../context/fragment-plan.js'
import type { BranchInput } from '../../models.js'

/** 证据已经由 Host 按 owner、会话及运行锚点核验。保留其原有序列化格式。 */
export function assembleOwnerReflectionInput<Wire>(input: BranchInput<Wire>): BranchInput<Wire> {
  const { system, turn } = compileContextFragments([
    { id: 'reflection.owner.instructions', region: 'system', kind: 'instruction', value: input.stableSystem },
    { id: 'reflection.owner.evidence', region: 'turn', kind: 'data', value: input.delta },
  ])
  return { ...input, stableSystem: system[0]!.value, delta: turn[0]!.value }
}

export { formatOwnerReflectionEvidence } from './context.js'
