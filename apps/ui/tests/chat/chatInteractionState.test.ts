import { describe, expect, it } from 'vitest'
import { findPendingTextInteractionId, type ChatMessage } from '@/components/common/gugu-chat/chatTypes'

function pendingInteraction(
  promptId: number,
  options: NonNullable<ChatMessage['interaction']>['options'] = [],
  extra: Partial<NonNullable<ChatMessage['interaction']>> = {},
): ChatMessage {
  return {
    id: promptId,
    role: 'interaction',
    text: '',
    time: '09:30',
    interaction: {
      promptId,
      kind: 'question',
      title: '问题',
      body: '请回答',
      options,
      allowTextInput: true,
      ...extra,
    },
  }
}

describe('聊天输入框的交互回答目标恢复', () => {
  it('刷新恢复的无选项开放问题仍路由到原交互，而不是普通发送队列', () => {
    const restored = pendingInteraction(42)

    expect(findPendingTextInteractionId([restored])).toBe(42)
  })

  it('只含自定义回复兜底项的开放问题无需先消费按钮 token', () => {
    const restored = pendingInteraction(43, [
      { id: '__custom_reply__', label: '自定义回复', token: 'fresh-token' },
    ])

    expect(findPendingTextInteractionId([restored])).toBe(43)
  })

  it('Web 卡片内回答模式不把底部输入框绑定到待处理问题', () => {
    const restored = pendingInteraction(48)

    expect(findPendingTextInteractionId([restored], 'inline')).toBeNull()
    expect(findPendingTextInteractionId([restored], 'composer')).toBe(48)
  })

  it('有真实选项时需先启用自定义回复；启用状态恢复后继续指向原问题', () => {
    const restored = pendingInteraction(44, [
      { id: 'weather', label: '查天气', token: 'weather-token' },
      { id: '__custom_reply__', label: '自定义回复', token: 'fresh-token' },
    ])

    expect(findPendingTextInteractionId([restored])).toBeNull()
    restored.interaction!.customInputActive = true
    expect(findPendingTextInteractionId([restored])).toBe(44)
  })

  it('跳过已解决和系统确认卡，并选择最新可直接回答的问题', () => {
    const messages = [
      pendingInteraction(45),
      pendingInteraction(46, [], { resolved: true }),
      pendingInteraction(47, [], { kind: 'confirm' }),
    ]

    expect(findPendingTextInteractionId(messages)).toBe(45)
  })
})
