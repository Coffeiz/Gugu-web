// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, reactive, ref } from 'vue'
import GuguChatImConnect from '@/components/common/gugu-chat/GuguChatImConnect.vue'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/components/common/icons/Icon.vue', async () => {
  const { h } = await import('vue')
  return { default: { render: () => h('span') } }
})
vi.mock('@/components/common/gugu-chat/SessionTitleEdit.vue', async () => {
  const { h } = await import('vue')
  return { default: { props: ['title'], render() { return h('span', { class: 'test-session-title' }, this.title) } } }
})

let app: ReturnType<typeof createApp> | undefined
let host: HTMLDivElement | undefined

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = undefined
  host = undefined
})

describe('GuguChat Telegram channel', () => {
  it('shows Telegram, routes setup to personal settings, and lists its existing sessions', async () => {
    const telegramBots = ref<unknown[]>([])
    const telegramSessions = ref([{ id: 42, title: 'Telegram chat', source: 'telegram' }])
    const openSettings = vi.fn()
    const loadSession = vi.fn()
    host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp(GuguChatImConnect, {
      imPlatforms: [{ key: 'telegram', label: 'chatUi.telegram' }],
      imOpen: reactive({ telegram: true }),
      imHighlight: false,
      botsOf: () => telegramBots.value,
      imSessionsOf: () => telegramSessions.value,
      sessionId: null,
      connect: null,
      connectHint: '',
      connectErr: '',
      connecting: '',
      formatSessionTime: () => '',
      onOpenTelegramSettings: openSettings,
      onTogglePlatform: vi.fn(),
      onSetConnectCanvas: vi.fn(),
      onStartImConnect: vi.fn(),
      onCancelImConnect: vi.fn(),
      onLoadSession: loadSession,
      onDeleteSession: vi.fn(),
      onRenameSession: vi.fn(),
    })
    app.mount(host)
    await nextTick()

    expect(host.textContent).toContain('chatUi.telegram')
    expect(host.textContent).toContain('chatUi.telegramSetupHint')
    expect(host.querySelector('.im-connect-btn')?.textContent).toContain('chatUi.openTelegramSettings')
    expect(host.querySelector('.im-qr-box')).toBeNull()
    ;(host.querySelector('.im-connect-btn') as HTMLButtonElement).click()
    expect(openSettings).toHaveBeenCalledOnce()

    telegramBots.value = [{ platform: 'telegram', enabled: true }]
    await nextTick()
    expect(host.textContent).toContain('Telegram chat')
    expect(host.querySelector('.im-connect-btn')).toBeNull()
    ;(host.querySelector('.exp-session-item') as HTMLDivElement).click()
    expect(loadSession).toHaveBeenCalledWith(42)
  })
})
