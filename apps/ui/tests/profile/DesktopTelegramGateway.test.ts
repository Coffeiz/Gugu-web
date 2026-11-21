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
