import { searcherDefinition } from '../../subagent/searcher/definition.js'
import { compileContextFragments } from '../fragment-plan.js'

export const builtinSubagentCatalog = [searcherDefinition] as const

/** 调用方传入已授权的目录。按 ID 排序，使相同目录的 system 前缀保持稳定。 */
export function assembleSubagentCatalog(system: string | undefined,
  entries: readonly { id: string; description: string }[]): string | undefined {
  if (!entries.length) return system
  const catalog = [...entries].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  const fragments = compileContextFragments([
    { id: 'main.instructions', version: 1, region: 'system', kind: 'instruction', value: system ?? '' },
    { id: 'main.subagent_catalog', version: 7, region: 'system', kind: 'instruction',
      value: [
        '可委派的子 Agent',
        ...catalog.map(entry => `${entry.id}：${entry.description}`),
        '',
        '优先委派。遇到多来源查证、跨多份文件比对、复杂排查或其他多步任务，先拆出可独立完成的部分。只要目录里有能力匹配的助手，就在自己开始这部分工作前派单。互不依赖的事项可以同时派出。单步任务或没有合适助手时直接处理。',
        '',
        '派单与分工。交代目标、范围、必要的已授权资料和预期结果。派单成功后，记下返回的 childId，简短告诉用户已交给助手，再推进未委派且不依赖结果的工作。',
        '',
        '自动续跑。派单后可以先告诉用户进度，再处理未委派的工作。当前 Run 准备结束时，系统会自动等待尚未返回的子任务，收到结果后继续执行。需要查看未读消息或报告时可调用 agent_inbox。信箱为空时立即返回，由系统负责等待和唤醒。',
        '',
        '核对与交付。收到结果后，核对关键结论、来源和影响用户判断的疑点。证据不足时优先请原助手补查；只有助手无法继续时，才接手必要部分。最后整合结果回复用户。',
      ].join('\n') },
  ])
  return fragments.system.map(fragment => fragment.value).filter(Boolean).join('\n\n')
}
