// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h } from 'vue'
import GroupChatSettings from '@/im/connect/GroupChatSettings.vue'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/composables/core/useConfirmDialog', () => ({ confirmDialog: vi.fn().mockResolvedValue(true) }))

let app: ReturnType<typeof createApp> | undefined
let host: HTMLDivElement | undefined

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = undefined
  host = undefined
})

describe('IM 共享群设置', () => {
  it('按统一顺序展示回应、格式、流式、三项记忆和群工具设置', () => {
    host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp({
      render: () => h(GroupChatSettings, {
        showGroupToggle: true,
        groupChatHint: 'profileImUi.groupChatHint',
        groupChatEnabled: true,
        groupSettingsVisible: true,
        groupResponseMode: 'reply_mentions',
        messageFormatBot: { group_message_format: 'compat', private_message_format: 'markdown', private_streaming_enabled: true },
        groupOwnerMemoryEnabled: false,
        groupMemoryEnabled: true,
        memberMemoryEnabled: true,
        enabledTools: [],
      }),
    })
    app.mount(host)

    const labels = [...host.querySelectorAll('.pm-bot-group-row .pm-field-name')]
      .map(element => element.textContent)
    expect(labels).toEqual([
      'profileImUi.groupChat',
      'profileImUi.responseMode',
      'profileImUi.groupMessageFormat',
      'profileImUi.privateMessageFormat',
      'profileImUi.privateStreaming',
      'profileImUi.groupOwnerMemory',
      'profileImUi.groupMemory',
      'profileImUi.memberMemory',
      'profileImUi.memberTools',
    ])
  })

  it('群聊关闭时隐藏群回应和记忆设置，但保留私聊格式与私聊流式', () => {
    host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp({
      render: () => h(GroupChatSettings, {
        showGroupToggle: true,
        groupChatHint: 'profileImUi.groupChatHint',
        groupChatEnabled: false,
        groupSettingsVisible: false,
        groupResponseMode: 'reply_mentions',
        messageFormatBot: { private_message_format: 'markdown', private_streaming_enabled: true },
        groupOwnerMemoryEnabled: false,
        groupMemoryEnabled: true,
        memberMemoryEnabled: true,
        enabledTools: [],
      }),
    })
    app.mount(host)

    const labels = [...host.querySelectorAll('.pm-bot-group-row .pm-field-name')]
      .map(element => element.textContent)
    expect(labels).toEqual([
      'profileImUi.groupChat',
      'profileImUi.privateMessageFormat',
      'profileImUi.privateStreaming',
    ])
  })

  it('飞书和 Telegram 复用群设置组件并显示参与度选项，不显示 QQ 专属消息格式', () => {
    host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp({
      render: () => h(GroupChatSettings, {
        showGroupToggle: true,
        groupChatHint: 'profileImUi.telegramGroupChatHint',
        groupChatEnabled: true,
        groupSettingsVisible: true,
        groupResponseMode: 'reply_all',
        groupAttentionMode: 'natural',
        showAttentionMode: true,
        showMessageFormat: false,
        responseModeHint: 'profileImUi.telegramGroupResponseHint',
        responseGuide: 'telegram',
        messageFormatBot: {},
        groupOwnerMemoryEnabled: true,
        groupMemoryEnabled: true,
        memberMemoryEnabled: true,
        enabledTools: [],
      }),
    })
    app.mount(host)

    const labels = [...host.querySelectorAll('.pm-bot-group-row .pm-field-name')]
      .map(element => element.textContent)
    expect(labels).toEqual([
      'profileImUi.groupChat',
      'profileImUi.responseMode',
      'profileImUi.groupAttentionMode',
      'profileImUi.groupOwnerMemory',
      'profileImUi.groupMemory',
      'profileImUi.memberMemory',
      'profileImUi.memberTools',
    ])
  })
})
