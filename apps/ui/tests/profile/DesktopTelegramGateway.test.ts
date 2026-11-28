// @vitest-environment jsdom
import { createApp, nextTick } from 'vue'
import { expect, it, vi } from 'vitest'
import DesktopTelegramGateway from '../../src/desktop/im/connect/platforms/telegram/DesktopTelegramGateway.vue'

const mocks = vi.hoisted(() => ({
  request: vi.fn(async () => ({ configured: true, bound: true, enabled: true, status: 'connected', messages: [] })),
  confirm: vi.fn(async () => false),
}))

vi.mock('@desktop/bridge/bridge', () => ({ hasDesktopTelegramGateway: () => true, requestDesktopTelegram: mocks.request }))
vi.mock('@/composables/core/useConfirmDialog', () => ({ confirmDialog: mocks.confirm }))
vi.mock('@/i18n', () => ({ i18n: { global: { t: (key: string) => key, locale: { value: 'zh-CN' } } } }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

it('Telegram 停用确认取消后保留连接', async () => {
  const host = document.createElement('div')
  const app = createApp(DesktopTelegramGateway)
  app.mount(host)
  try {
    await nextTick()
    await nextTick()
    const stop = [...host.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === 'profileImUi.disableBot')
    expect(stop).toBeDefined()
    stop?.click()
    await nextTick()
    expect(mocks.confirm).toHaveBeenCalledOnce()
    expect(mocks.request).toHaveBeenCalledExactlyOnceWith({ action: 'status' })
  } finally { app.unmount() }
})

it('桌面 Telegram 显示与其他群平台一致的回应、参与度、记忆和工具设置，并保存到本机适配器', async () => {
  mocks.request.mockImplementation(async () => ({
    configured: true, bound: true, enabled: true, status: 'connected', messages: [],
    groupChatEnabled: true, groupReplyMode: 'reply_all', groupAttentionMode: 'autonomous',
    privateStreamingEnabled: true, groupOwnerMemoryEnabled: false, groupMemoryEnabled: true,
    memberMemoryEnabled: true, groupHistorySearchEnabled: true,
  }))
  const host = document.createElement('div')
  const app = createApp(DesktopTelegramGateway)
  app.mount(host)
  try {
    await nextTick()
    await nextTick()
    const card = host.querySelector('.pm-bot-item') as HTMLElement
    const labels = [...card.querySelectorAll('.pm-bot-group-row .pm-field-name')].map(element => element.textContent)
    expect(labels).toEqual([
      'profileImUi.telegramBinding', 'profileImUi.groupChat', 'profileImUi.responseMode',
      'profileImUi.groupAttentionMode', 'profileImUi.privateStreaming', 'profileImUi.groupOwnerMemory',
      'profileImUi.groupMemory', 'profileImUi.memberMemory', 'profileImUi.memberTools',
    ])

    ;(card.querySelector('[aria-label="profileImUi.toggleGroupMemory"]') as HTMLButtonElement).click()
    await nextTick()
    expect(mocks.request).toHaveBeenCalledWith({ action: 'updateGroupSettings', patch: { groupMemoryEnabled: false } })
    ;(card.querySelector('[data-tool-option="group_context_search"]') as HTMLButtonElement).click()
    await nextTick()
    expect(mocks.request).toHaveBeenCalledWith({ action: 'updateGroupSettings', patch: { groupHistorySearchEnabled: false } })
    ;(card.querySelector('[aria-label="profileImUi.privateStreaming"]') as HTMLButtonElement).click()
    await nextTick()
    expect(mocks.request).toHaveBeenCalledWith({ action: 'setPrivateStreaming', enabled: false })
  } finally { app.unmount(); host.remove() }
})
