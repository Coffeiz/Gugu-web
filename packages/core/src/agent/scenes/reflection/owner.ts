import { compileContextFragments } from '../../context/fragment-plan.js'
import type { BranchInput } from '../../models.js'

/** 证据已经由 Host 按 owner、会话及运行锚点核验。保留其原有序列化格式。 */
export function assembleOwnerReflectionInput<Wire>(input: BranchInput<Wire>): BranchInput<Wire> {
  const { system, turn } = compileContextFragments([
    { id: 'reflection.owner.instructions', version: 1, region: 'system', kind: 'instruction', value: input.stableSystem },
    { id: 'reflection.owner.evidence', version: 1, region: 'turn', kind: 'data', value: input.delta },
  ])
  return { ...input, stableSystem: system[0]!.value, delta: turn[0]!.value }
}

/** 记忆状态和已验证证据各自声明用途，保留 Web 与桌面原 JSON 字段顺序。 */
export function formatOwnerReflectionEvidence<State extends { date: string; userName: string }, Turn>(
  state: State, turns: readonly Turn[],
): string {
  const { turn } = compileContextFragments<State | readonly Turn[]>([
    { id: 'reflection.owner.memory-state', version: 1, region: 'turn', kind: 'data', value: state },
    { id: 'reflection.owner.evidence', version: 1, region: 'turn', kind: 'data', value: turns },
  ])
  return JSON.stringify({ ...turn[0]!.value, turns: turn[1]!.value })
}
