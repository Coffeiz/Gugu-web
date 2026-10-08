// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import ProfileImPane from '@/components/common/profile/ProfileImPane.vue'

const mocks = vi.hoisted(() => ({
  preferences: {
    showToolInteractions: false,
    showIntermediateReplies: false,
    fetch: vi.fn(),
    saveShowToolInteractions: vi.fn(),
    saveShowIntermediateReplies: vi.fn(),
  },
  list: vi.fn(),
  update: vi.fn(),
  feishuStart: vi.fn(),
  qrToCanvas: vi.fn(),
}))

vi.mock('@/stores/preferences', () => ({ usePreferencesStore: () => mocks.preferences }))
vi.mock('@/services/api', () => ({
  userBotsApi: { list: mocks.list, update: mocks.update },
  feishuConnectApi: { start: mocks.feishuStart, poll: vi.fn() },
  qqConnectApi: { start: vi.fn(), poll: vi.fn() },
  wechatConnectApi: { start: vi.fn(), poll: vi.fn() },
}))
vi.mock('qrcode', () => ({ default: { toCanvas: mocks.qrToCanvas } }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/composables/core/useConfirmDialog', () => ({ confirmDialog: vi.fn() }))
vi.mock('@/components/common/overlays/PopupMenu.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/common/icons/Icon.vue', () => ({ default: { template: '<span />' } }))
vi.mock('@/components/common/profile/MessageFormatSettings.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/common/profile/GroupOwnerMemorySwitch.vue', () => ({ default: { template: '<div />' } }))

let app: ReturnType<typeof createApp> | undefined
let host: HTMLDivElement | undefined

async function flushUi() {
  await Promise.resolve()
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = undefined
  host = undefined
  mocks.list.mockReset()
  mocks.update.mockReset()
  mocks.feishuStart.mockReset()
  mocks.qrToCanvas.mockReset()
  delete (HTMLElement.prototype as HTMLElement & { scrollIntoView?: unknown }).scrollIntoView
})

describe('个人设置中的 IM 群权限', () => {
  it('分别读取 QQ 与飞书群聊开关，并只写回当前平台字段', async () => {
    mocks.list.mockResolvedValue({ items: [
      { id: 1, platform: 'qq', enabled: true, group_chat_enabled: false },
      { id: 2, platform: 'feishu', enabled: true, feishu_group_chat_enabled: null },
    ] })
    mocks.update.mockResolvedValue({})
    host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp(ProfileImPane)
    app.mount(host)
    await flushUi()

    const botRows = host.querySelectorAll('.pm-bot-item')
    const feishuGroupToggle = botRows[0].querySelector('.toggle-switch[aria-label="profileImUi.toggleGroupChat"]') as HTMLButtonElement
    const qqGroupToggle = botRows[1].querySelector('.toggle-switch[aria-label="profileImUi.toggleGroupChat"]') as HTMLButtonElement
    expect(feishuGroupToggle.getAttribute('aria-pressed')).toBe('true') // 历史飞书 null 保持开启
    expect(qqGroupToggle.getAttribute('aria-pressed')).toBe('false')

    feishuGroupToggle.click()
    await flushUi()
    expect(mocks.update).toHaveBeenCalledWith(2, { feishu_group_chat_enabled: false })
  })

  it('扫码二维码显示在发起连接的平台区块内，并滚动到二维码位置', async () => {
    mocks.list.mockResolvedValue({ items: [] })
    mocks.feishuStart.mockResolvedValue({ poll_id: 'poll-1', scan_url: 'https://example.test/qr' })
    mocks.qrToCanvas.mockResolvedValue(undefined)
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView })
    host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp(ProfileImPane)
    app.mount(host)
    await flushUi()

    ;(host.querySelector('[data-platform="feishu"] .pm-bind-btn') as HTMLButtonElement).click()
    await flushUi()

    const qr = host.querySelector('[data-platform="feishu"] .pm-qr-box')
    expect(qr).not.toBeNull()
    expect(host.querySelector('[data-platform="qq"] .pm-qr-box')).toBeNull()
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'nearest' })
    expect(mocks.qrToCanvas).toHaveBeenCalledOnce()
  })
})
