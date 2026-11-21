// @vitest-environment jsdom
import { createPinia } from 'pinia'
import { createApp } from 'vue'
import { expect, it, vi } from 'vitest'
import ProfilePreferencesPane from '@/components/common/profile/ProfilePreferencesPane.vue'
import { localPreferencesAccessKey } from '@/services/localPreferencesAccess'
import { i18n } from '@/i18n'
import { effectiveTimezone, setUserTimezone } from '@/utils/userTimezone'

const desktop = vi.hoisted(() => ({ appearance: vi.fn(), updateAppearance: vi.fn() }))


it('桌面复用现有时区选择器，保存后以本机偏好格式化时间', async () => {
  const appearance = {
    theme: 'light', themeFamily: 'glass', palette: 'neutral', timezone: 'Asia/Tokyo',
  }
  desktop.appearance.mockResolvedValue(appearance)
  desktop.updateAppearance.mockResolvedValue({ ...appearance, timezone: 'Europe/London' })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(ProfilePreferencesPane)
  app.use(createPinia()).use(i18n).provide(localPreferencesAccessKey, { ...desktop, clearAgentMemory: vi.fn(), clearAgentAttachments: vi.fn(), isMemoryBusy: () => false })
  app.mount(host)
  try {
    await vi.waitFor(() => expect(effectiveTimezone()).toBe('Asia/Tokyo'))
    const trigger = host.querySelector<HTMLButtonElement>('.pm-timezone-row button')!
    expect(trigger.disabled).toBe(false)
    trigger.click()
    const option = await vi.waitFor(() => {
      const choices = Array.from(document.querySelectorAll<HTMLElement>('.asel-popup .popup-menu-item'))
      const match = choices.find(element => element.textContent?.includes('Europe/London'))
      expect(match).toBeDefined()
      return match!
    })
    option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(effectiveTimezone()).toBe('Europe/London'))
    expect(desktop.updateAppearance).toHaveBeenCalledWith({ timezone: 'Europe/London' })
  } finally {
    app.unmount()
    host.remove()
    setUserTimezone(null)
  }
})
