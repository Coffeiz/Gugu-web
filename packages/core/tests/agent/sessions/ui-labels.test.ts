import { expect, it } from 'vitest'
import { createAgentUiLabels, DEFAULT_AGENT_STATE_LABELS } from '../../../src/agent/sessions/ui-labels.js'

it('按可信配置生成候选，忽略空覆盖并在每次读取时更新', () => {
  let overrides: Record<string, string | undefined> = { _thinking: '  甲 | \n 乙  ', _context_compaction: '', ordinary: '忽略' }
  const labels = createAgentUiLabels({ defaultStateLabels: DEFAULT_AGENT_STATE_LABELS, stateLabelOverrides: () => overrides })
  expect(labels()).toEqual({ thinking: ['甲', '乙'], contextCompacting: ['正在整理上下文…'] })
  overrides = { _thinking: ' \n | ', _context_compaction: ' 整理 | 继续\n\n' }
  expect(labels()).toEqual({ thinking: [], contextCompacting: ['整理', '继续'] })
})

it('读取配置失败向调用方传播，不把失败伪装成默认配置', () => {
  const error = new Error('合成读取失败')
  const labels = createAgentUiLabels({ defaultStateLabels: DEFAULT_AGENT_STATE_LABELS, stateLabelOverrides() { throw error } })
  expect(labels).toThrow(error)
})

it('拆分候选遵循 Python 空白集合，保留 BOM 并剥离 U+0085', () => {
  const labels = createAgentUiLabels({ defaultStateLabels: DEFAULT_AGENT_STATE_LABELS, stateLabelOverrides: () => ({ _thinking: '\u0085甲\u0085|\ufeff乙\ufeff|\u001c丙\u001f|\u0085', _context_compaction: '\ufeff' }) })
  expect(labels()).toEqual({ thinking: ['甲', '\ufeff乙\ufeff', '丙'], contextCompacting: ['\ufeff'] })
})
