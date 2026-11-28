import { searcherDefinition } from '../../subagent/searcher/definition.js'
import { compileContextFragments } from '../fragment-plan.js'

export const builtinSubagentCatalog = [searcherDefinition] as const

/** 调用方传入已授权的目录。按 ID 排序，使相同目录的 system 前缀保持稳定。 */
export function assembleSubagentCatalog(system: string | undefined,
  entries: readonly { id: string; description: string }[]): string | undefined {
  if (!entries.length) return system
  const catalog = [...entries].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  const fragments = compileContextFragments([
    { id: 'main.instructions', region: 'system', kind: 'instruction', value: system ?? '' },
    { id: 'main.subagent_catalog', region: 'system', kind: 'instruction',
      value: [
        '可委派的子 Agent',
        ...catalog.map(entry => `${entry.id}：${entry.description}`),
        '',
        '复杂任务可以委派独立的部分。派单前先判断能否复用同一会话已有的子 Agent：已有报告足以回答时直接用；同一目标的追问、补查、纠错，或能沿用已查资料时，优先用 agent_message 的 send，把新增要求发给原 childId。子 Agent 已完成也可以继续交办；仍在做同一件事时等待回传。',
        '需要复用但不确定 childId 或状态时，可以用 agent_inspect 查一次同会话的子 Agent。只有没有合适的已有子 Agent，或任务目标独立且确实需要并行、隔离上下文时，才用 spawn。交办时说明目标、范围、已授权资料和预期结果。',
        '派单后记下 childId，简短告知用户进度，再做不依赖结果的工作。系统会自动等待、回传并续跑。需要找历史未读报告时查信箱；不要轮询。',
        '收到报告后核对关键结论和来源。证据不足时请原助手补查，最后整合回复。',
      ].join('\n') },
  ])
  return fragments.system.map(fragment => fragment.value).filter(Boolean).join('\n\n')
}
