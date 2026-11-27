import { describe, expect, it } from 'vitest'
import { runForAssistantMessage } from '../../../loopscope/frontend/src/utils/assistantRunMapping'

describe('LoopScope 助手消息与运行映射', () => {
  it('无显式 runId 的确定性命令回复不继承相邻 Agent Run', () => {
    const messages = [
      { role: 'assistant', runId: 'run-a' },
      { role: 'assistant', runId: null },
      { role: 'assistant' },
    ]
    const runs = [{ id: 'run-a' }]

    expect(runForAssistantMessage(0, messages, runs, {})).toBe(runs[0])
    expect(runForAssistantMessage(1, messages, runs, {})).toBeUndefined()
    expect(runForAssistantMessage(2, messages, runs, {})).toBeUndefined()
  })

  it('优先使用显式 runId 与已加载的完整运行详情', () => {
    const summary = { id: 'run-a' }
    const detail = { id: 'run-a', spans: ['loaded'] }
    const messages = [{ role: 'assistant', runId: 'run-a' }]

    expect(runForAssistantMessage(0, messages, [summary], { 'run-a': detail })).toBe(detail)
  })
})
