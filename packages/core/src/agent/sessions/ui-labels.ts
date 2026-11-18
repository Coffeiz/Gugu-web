import { strip } from '../../shared/values.js'

export const DEFAULT_AGENT_STATE_LABELS = Object.freeze({
  _preparing: '咕咕正在整理…',
  _verify_prefix: '复查 · ',
  _thinking: '',
  _context_compaction: '正在整理上下文…',
})

export interface AgentUiLabelsSource {
  /** 调用方提供可信运行配置；读取失败原样传播。 */
  stateLabelOverrides(): Record<string, string | undefined>
  defaultStateLabels: Readonly<Record<string, string>>
}

const labelCandidates = (raw: string | undefined) => (raw ?? '').split(/[|\n]/u).map(strip).filter(Boolean)

export function createAgentToolLabelPicker(readOverrides: AgentUiLabelsSource['stateLabelOverrides']) {
  return (name: string): string | undefined => {
    const overrides = readOverrides()
    if (!Object.hasOwn(overrides, name)) return undefined
    const choices = labelCandidates(overrides[name])
    return choices[Math.floor(Math.random() * choices.length)]
  }
}

/** 特殊标签允许非空覆盖；多个展示候选按竖线和换行分隔。 */
export function createAgentUiLabels(source: AgentUiLabelsSource) {
  return () => {
    const overrides = Object.fromEntries(Object.entries(source.stateLabelOverrides())
      .filter(([key, value]) => key.startsWith('_') && Boolean(value)))
    const labels = { ...source.defaultStateLabels, ...overrides }
    return { thinking: labelCandidates(labels._thinking), contextCompacting: labelCandidates(labels._context_compaction) }
  }
}
