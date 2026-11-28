// @vitest-environment jsdom
import { createPinia } from 'pinia'
import { createApp } from 'vue'
import { expect, it, vi } from 'vitest'
import { i18n } from '@/i18n'
import ProfileGuguPane from '@/components/common/profile/ProfileGuguPane.vue'
import { localPreferencesAccessKey } from '@/services/localPreferencesAccess'

const ports = vi.hoisted(() => ({
  confirm: vi.fn(), clearDesktop: vi.fn(), clearWeb: vi.fn(),
  clearDesktopAttachments: vi.fn(), clearWebAttachments: vi.fn(),
}))
vi.mock('@/composables/core/useConfirmDialog', () => ({ confirmDialog: ports.confirm }))

vi.mock('@/services/api', () => ({
  agentApi: { clearMemory: ports.clearWeb, clearAttachments: ports.clearWebAttachments },
}))
vi.mock('@/components/common/profile/ProfilePersonalityPane.vue', () => ({ default: { render: () => null } }))

it('桌面清空记忆只有确认后才调用本机桥接', async () => {
  ports.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
  ports.clearDesktop.mockResolvedValue(null)
  const host = document.createElement('div')
  const app = createApp(ProfileGuguPane).use(createPinia()).use(i18n).provide(localPreferencesAccessKey, { appearance: vi.fn(), updateAppearance: vi.fn(), clearAgentMemory: ports.clearDesktop, clearAgentAttachments: ports.clearDesktopAttachments, isMemoryBusy: () => false })
  app.mount(host)
  try {
    const button = host.querySelector<HTMLButtonElement>('.pm-danger-btn')!
    button.click()
    await Promise.resolve()
    expect(ports.clearDesktop).not.toHaveBeenCalled()
    button.click()
    await vi.waitFor(() => expect(ports.clearDesktop).toHaveBeenCalledOnce())
    expect(ports.confirm).toHaveBeenLastCalledWith(expect.objectContaining({ tone: 'danger' }))
    expect(ports.clearWeb).not.toHaveBeenCalled()
  } finally { app.unmount() }
})

it('桌面清理附件只有确认后才调用本机接口，并显示清理数量', async () => {
  ports.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
  ports.clearDesktopAttachments.mockResolvedValue({ deleted: 2 })
  const host = document.createElement('div')
  const app = createApp(ProfileGuguPane).use(createPinia()).use(i18n).provide(localPreferencesAccessKey, { appearance: vi.fn(), updateAppearance: vi.fn(), clearAgentMemory: ports.clearDesktop, clearAgentAttachments: ports.clearDesktopAttachments, isMemoryBusy: () => false })
  app.mount(host)
  try {
    const button = host.querySelectorAll<HTMLButtonElement>('.pm-danger-btn')[1]!
    button.click()
    await Promise.resolve()
    expect(ports.clearDesktopAttachments).not.toHaveBeenCalled()
    button.click()
    await vi.waitFor(() => expect(host.textContent).toContain(i18n.global.t('profileGuguUi.attachmentsDeleted', { count: 2 })))
    expect(ports.clearDesktopAttachments).toHaveBeenCalledOnce()
    expect(ports.clearWebAttachments).not.toHaveBeenCalled()
  } finally { app.unmount() }
})
