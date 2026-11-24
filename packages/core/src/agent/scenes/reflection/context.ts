import { compileContextFragments } from '../../context/fragment-plan.js'

/** 记忆状态和已验证证据各自声明用途，保留 Web 与桌面原 JSON 字段顺序。 */
export function formatOwnerReflectionEvidence<State extends { date: string; userName: string }, Turn>(
  state: State, turns: readonly Turn[],
): string {
  const { turn } = compileContextFragments<State | readonly Turn[]>([
    { id: 'reflection.owner.memory-state', region: 'turn', kind: 'data', value: state },
    { id: 'reflection.owner.evidence', region: 'turn', kind: 'data', value: turns },
  ])
  return JSON.stringify({ ...turn[0]!.value, turns: turn[1]!.value })
}
