import { describe, expect, it } from 'vitest'
import { runForAssistantMessage } from '../../../loopscope/frontend/src/utils/assistantRunMapping'

describe('LoopScope 助手消息与运行映射', () => {
  it('按时间顺序的助手消息映射到倒序加载的最近 runs', () => {
    const messages = [
      { role: 'assistant' },
      { role: 'user' },
      { role: 'assistant' },
    ]
    const runs = [{ id: 'new-run' }, { id: 'old-run' }]

    expect(runForAssistantMessage(0, messages, runs, {})).toBe(runs[1])
    expect(runForAssistantMessage(2, messages, runs, {})).toBe(runs[0])
  })

  it('较旧助手消息超出已加载 runs 窗口时不误配新 run', () => {
    const messages = [
      { role: 'assistant' },
      { role: 'assistant' },
      { role: 'assistant' },
    ]
    const runs = [{ id: 'new-run' }, { id: 'middle-run' }]

    expect(runForAssistantMessage(0, messages, runs, {})).toBeUndefined()
    expect(runForAssistantMessage(1, messages, runs, {})).toBe(runs[1])
    expect(runForAssistantMessage(2, messages, runs, {})).toBe(runs[0])
  })

  it('优先使用显式 runId 与已加载的完整运行详情', () => {
    const summary = { id: 'run-a' }
    const detail = { id: 'run-a', spans: ['loaded'] }
    const messages = [{ role: 'assistant', runId: 'run-a' }]

    expect(runForAssistantMessage(0, messages, [summary], { 'run-a': detail })).toBe(detail)
  })
})
