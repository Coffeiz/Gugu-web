// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadMessagePage, saveBootstrap } from '../../../loopscope/frontend/src/services/gugu'
import { runForAssistantMessage } from '../../../loopscope/frontend/src/utils/assistantRunMapping'

describe('LoopScope 历史消息 Run 关联', () => {
  beforeEach(() => {
    sessionStorage.clear()
    saveBootstrap({ apiBase: `${window.location.origin}/gugu-api` })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    sessionStorage.clear()
  })

  it('保留 API 普通消息的 runId，使同一 Run 的多条助手消息仍绑定同一运行', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      messages: [
        { id: 101, role: 'assistant', content: '第一轮', runId: 'run-a', timelineOrder: 101000 },
        { id: 102, role: 'assistant', content: '第二轮', runId: 'run-a', timelineOrder: 102000 },
        { id: 103, role: 'assistant', content: '下一条运行', runId: 'run-b', timelineOrder: 103000 },
      ],
      timelineEvents: [],
      toolEvents: [],
      pagination: {},
    }), { headers: { 'Content-Type': 'application/json' } })))

    const page = await loadMessagePage(42)
    const runsNewestFirst = [{ id: 'run-b' }, { id: 'run-a' }]

    expect(page.messages.map(message => message.runId)).toEqual(['run-a', 'run-a', 'run-b'])
    expect(runForAssistantMessage(0, page.messages, runsNewestFirst, {})).toBe(runsNewestFirst[1])
    expect(runForAssistantMessage(1, page.messages, runsNewestFirst, {})).toBe(runsNewestFirst[1])
    expect(runForAssistantMessage(2, page.messages, runsNewestFirst, {})).toBe(runsNewestFirst[0])
  })
})
