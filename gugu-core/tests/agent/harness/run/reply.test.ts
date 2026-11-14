import { describe,expect,it } from 'vitest'
import type { ReplyFacts } from "../../../../src/agent/harness/index.js"
import { decideReply,goalCompleted,initialReplyState,stripGoalMarker,toolReplyProgress } from "../../../../src/agent/harness/index.js"

const facts: ReplyFacts = {
  empty: false, narration: false, announcesIntent: false, endsWithColon: false, toolProgressOnly: false,
  requiresTools: false, decisionDodge: false, decisionGuardEnabled: true,
  prompts: { narration: '合成叙述提醒', intent: '合成行动提醒', colon: '合成冒号提醒', tools: '合成工具提醒', decision: '合成决策提醒' },
  emptyFallback: '合成空回复文案',
}

describe('回复守卫跨轮编排', () => {
  it('空回复最多重试两次，之后正常文案完成；工具实际成功后重新获得空回复额度', () => {
    let state = initialReplyState
    for (let attempt = 0;attempt < 2;attempt++) {
      const decision = decideReply(state, { ...facts, empty: true })
      expect(decision.action).toBe('retry')
      expect(decision.retryKind).toBe('empty')
      state = decision.state
    }
    expect(decideReply(state, { ...facts, empty: true })).toMatchObject({ action: 'complete', visible: 'fallback' })
    expect(decideReply(toolReplyProgress(state, true), { ...facts, empty: true })).toMatchObject({ action: 'retry', retryKind: 'empty' })
    expect(decideReply(toolReplyProgress(state, false), { ...facts, empty: true })).toMatchObject({ action: 'complete', visible: 'fallback' })
  })

  it.each([
    ['narration', '合成叙述提醒'], ['announcesIntent', '合成行动提醒'], ['endsWithColon', '合成冒号提醒'], ['requiresTools', '合成工具提醒'], ['decisionDodge', '合成决策提醒'],
  ] as const)('首次%s只加一轮提醒，后续守卫轮不能被重复触发或输出未交付正文', (kind, prompt) => {
    const retry = decideReply(initialReplyState, { ...facts, [kind]: true })
    expect(retry).toMatchObject({ action: 'retry', retryKind: 'guard', prompt })
    const final = decideReply(retry.state, { ...facts, [kind]: true })
    expect(final).toMatchObject({ action: 'complete', visible: 'suppressed' })
    expect(final.state.guardPending).toBe(false)
  })

  it('冒号续轮得到真实正文才允许展示，其余guard续轮保持隐藏', () => {
    const colon = decideReply(initialReplyState, { ...facts, endsWithColon: true })
    expect(decideReply(colon.state, facts)).toMatchObject({ action: 'complete', visible: 'original' })
    const narration = decideReply(initialReplyState, { ...facts, narration: true })
    expect(decideReply(narration.state, facts)).toMatchObject({ action: 'complete', visible: 'suppressed' })
    expect(decideReply(colon.state, { ...facts, requiresTools: true })).toMatchObject({ action: 'complete', visible: 'suppressed' })
  })

  it('工具开始清理守卫缓冲状态，已有实际工具调用后不误触发首轮叙述与tool-required检查', () => {
    const retry = decideReply(initialReplyState, { ...facts, narration: true })
    const afterTool = toolReplyProgress(retry.state)
    expect(afterTool.guardPending).toBe(false)
    expect(decideReply(afterTool, { ...facts, narration: true, requiresTools: true })).toMatchObject({ action: 'complete', visible: 'original' })
  })

  it('普通完成字样不能冒充goal内部完成标记，标记剥除不改变其他正文', () => {
    expect(goalCompleted('目标已完成')).toBe(false)
    expect(goalCompleted('目标完成<!-- GUGU_GOAL_DONE -->')).toBe(true)
    expect(stripGoalMarker('目标完成<!-- GUGU_GOAL_DONE -->  ')).toBe('目标完成')
  })
})
