// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, reactive } from 'vue'
import ProfileImPane from '@/components/common/profile/ProfileImPane.vue'

const mocks = vi.hoisted(() => ({
  preferences: {
    showToolInteractions: true,
    showIntermediateReplies: false,
    fetch: vi.fn(),
    saveShowToolInteractions: vi.fn(),
    saveShowIntermediateReplies: vi.fn(),
  },
  list: vi.fn(),
  update: vi.fn(),
  feishuStart: vi.fn(),
  telegramConnect: vi.fn(),
  telegramReplace: vi.fn(),
  telegramBinding: vi.fn(),
  qrToCanvas: vi.fn(),
  liveState: null as { rev: { im_channels: number }; connected: boolean } | null,
}))

mocks.liveState = reactive({ rev: { im_channels: 0 }, connected: false })

vi.mock('@/stores/preferences', () => ({ usePreferencesStore: () => mocks.preferences }))
vi.mock('@/stores/live', () => ({ useLiveStore: () => mocks.liveState }))
vi.mock('@/services/api', () => ({
  userBotsApi: { list: mocks.list, update: mocks.update },
  feishuConnectApi: { start: mocks.feishuStart, poll: vi.fn() },
  qqConnectApi: { start: vi.fn(), poll: vi.fn() },
  wechatConnectApi: { start: vi.fn(), poll: vi.fn() },
  telegramConnectApi: {
    connect: mocks.telegramConnect,
    replace: mocks.telegramReplace,
    createBindingCode: mocks.telegramBinding,
  },
}))
vi.mock('qrcode', () => ({ default: { toCanvas: mocks.qrToCanvas } }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/composables/core/useConfirmDialog', () => ({ confirmDialog: vi.fn() }))
vi.mock('@/components/common/overlays/PopupMenu.vue', async () => {
  const { h } = await import('vue')
  return { default: {
    props: ['show'],
    setup(props: { show: boolean }, { slots }: { slots: { default?: () => unknown[] } }) {
      return () => props.show ? h('div', { class: 'popup-menu-host' }, slots.default?.()) : null
    },
  } }
})
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
  mocks.telegramConnect.mockReset()
  mocks.telegramReplace.mockReset()
  mocks.telegramBinding.mockReset()
  mocks.qrToCanvas.mockReset()
  if (mocks.liveState) {
    mocks.liveState.rev.im_channels = 0
    mocks.liveState.connected = false
  }
  delete (HTMLElement.prototype as HTMLElement & { scrollIntoView?: unknown }).scrollIntoView
})

describe('个人设置中的 IM 群权限', () => {
  it('IM 展示偏好默认显示工具调用并隐藏中间回复', async () => {
    mocks.list.mockResolvedValue({ items: [] })
    host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp(ProfileImPane)
    app.mount(host)
    await flushUi()

    expect(host.querySelector('.toggle-switch[aria-label="profileImUi.toggleToolInteractions"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(host.querySelector('.toggle-switch[aria-label="profileImUi.toggleIntermediateReplies"]')?.getAttribute('aria-pressed')).toBe('false')
  })

  it('按服务端公布的支持平台隐藏全局关闭的平台接入入口', async () => {
    mocks.list.mockResolvedValue({ items: [], supported_platforms: ['qq', 'telegram'] })
    host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp(ProfileImPane)
    app.mount(host)
    await flushUi()

    expect(host.querySelector('[data-platform="qq"]')).not.toBeNull()
    expect(host.querySelector('[data-platform="telegram"]')).not.toBeNull()
    expect(host.querySelector('[data-platform="feishu"]')).toBeNull()
    expect(host.querySelector('[data-platform="wechat"]')).toBeNull()
  })

  it('新 Bot 缺少群策略字段时默认仅回应 @ 并启用群上下文搜索', async () => {
    mocks.list.mockResolvedValue({ items: [{
      id: 9, platform: 'telegram', enabled: true, group_chat_enabled: true,
    }] })
    host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp(ProfileImPane)
    app.mount(host)
    await flushUi()

    const botRow = host.querySelector('[data-platform="telegram"] .pm-bot-item') as HTMLElement
    const mentions = Array.from(botRow.querySelectorAll('.pm-tool-options button'))
      .find(button => button.textContent?.includes('profileImUi.replyMentions')) as HTMLButtonElement
    const contextSearch = Array.from(botRow.querySelectorAll('.pm-tool-options button'))
      .find(button => button.textContent?.includes('profileImUi.groupContextSearch')) as HTMLButtonElement
    expect(mentions.classList.contains('active')).toBe(true)
    expect(contextSearch.classList.contains('active')).toBe(true)
  })

  it('Telegram 回应方式的引导说明如何关闭 Privacy Mode 并启用被提及回应', async () => {
    mocks.list.mockResolvedValue({ items: [{
      id: 8, platform: 'telegram', enabled: true, group_chat_enabled: true,
    }] })
    host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp(ProfileImPane)
    app.mount(host)
    await flushUi()

    const telegramBlock = host.querySelector('[data-platform="telegram"]') as HTMLElement
    const guideButton = telegramBlock.querySelector('.pm-help-toggle') as HTMLButtonElement
    expect(guideButton).not.toBeNull()
    guideButton.click()
    await flushUi()

    const guide = telegramBlock.querySelector('.pm-help-pop') as HTMLElement
    expect(guide.textContent).toContain('profileImUi.telegramGroupGuideTitle')
    expect(guide.textContent).toContain('profileImUi.telegramGroupGuideStep1')
    expect(guide.textContent).toContain('profileImUi.telegramGroupGuideStep2')
    expect(guide.textContent).toContain('profileImUi.telegramGroupGuideStep3')
    expect(guide.textContent).toContain('profileImUi.telegramGroupGuideNote')
    expect(guide.textContent).not.toContain('profileImUi.fullMessageTitle')
  })

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

  it('Telegram 群开关启用后显示独立回应、记忆与成员工具策略并写回 Bot 设置', async () => {
    mocks.list.mockResolvedValue({ items: [{
      id: 7, platform: 'telegram', enabled: true, group_chat_enabled: false,
      group_allowed_tools: ['web_search', 'http_get', 'image_search', 'read_file', 'send_file'],
    }] })
    mocks.update.mockResolvedValue({})
    host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp(ProfileImPane)
    app.mount(host)
    await flushUi()

    const botRow = host.querySelector('[data-platform="telegram"] .pm-bot-item') as HTMLElement
    const groupToggle = botRow.querySelector('.toggle-switch[aria-label="profileImUi.toggleGroupChat"]') as HTMLButtonElement
    expect(groupToggle.getAttribute('aria-pressed')).toBe('false')
    groupToggle.click()
    await flushUi()
    expect(mocks.update).toHaveBeenCalledWith(7, { group_chat_enabled: true })

    const recordOnly = Array.from(botRow.querySelectorAll('.pm-tool-options button'))
      .find(button => button.textContent?.includes('profileImUi.recordOnly')) as HTMLButtonElement
    recordOnly.click()
    await flushUi()
    expect(mocks.update).toHaveBeenCalledWith(7, { group_response_mode: 'record_only' })

    const groupMemoryToggle = botRow.querySelector('.toggle-switch[aria-label="profileImUi.toggleGroupMemory"]') as HTMLButtonElement
    groupMemoryToggle.click()
    await flushUi()
    expect(mocks.update).toHaveBeenCalledWith(7, { group_memory_enabled: false })

    const contextTool = Array.from(botRow.querySelectorAll('.pm-tool-options button'))
      .find(button => button.textContent?.includes('profileImUi.groupContextSearch')) as HTMLButtonElement
    contextTool.click()
    await flushUi()
    expect(mocks.update).toHaveBeenCalledWith(7, {
      group_allowed_tools: ['web_search', 'http_get', 'image_search', 'read_file', 'send_file', 'group_context_search'],
    })
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

  it('Telegram Token 只通过提交接口发送，成功后立即清空输入并刷新连接状态', async () => {
    mocks.list.mockResolvedValue({ items: [] })
    mocks.telegramConnect.mockResolvedValue({ id: 7, platform: 'telegram' })
    host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp(ProfileImPane)
    app.mount(host)
    await flushUi()

    ;(host.querySelector('[data-platform="telegram"] .pm-bind-btn') as HTMLButtonElement).click()
    await flushUi()
    const input = host.querySelector('#telegram-bot-token') as HTMLInputElement
    input.value = '123456:synthetic-token-not-a-credential'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    ;(host.querySelector('.pm-telegram-token-controls button[type="submit"]') as HTMLButtonElement).click()
    await flushUi()

    expect(mocks.telegramConnect).toHaveBeenCalledWith('123456:synthetic-token-not-a-credential')
    expect(host.querySelector('#telegram-bot-token')).toBeNull()
    expect(host.textContent).not.toContain('123456:synthetic-token-not-a-credential')
    expect(mocks.list).toHaveBeenCalledTimes(2)
  })

  it('Telegram Token 轮换请求只使用 Bot 记录 ID 路由且不回显 Token', async () => {
    mocks.list.mockResolvedValue({ items: [{ id: 17, platform: 'telegram', name: '@sample_bot', app_id: '9001', enabled: true }] })
    mocks.telegramReplace.mockResolvedValue({ id: 17, platform: 'telegram' })
    host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp(ProfileImPane)
    app.mount(host)
    await flushUi()

    ;(host.querySelector('[data-platform="telegram"] .pm-bind-btn') as HTMLButtonElement).click()
    await flushUi()
    const input = host.querySelector('#telegram-bot-token') as HTMLInputElement
    input.value = '123456:another-synthetic-token'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    ;(host.querySelector('.pm-telegram-token-controls button[type="submit"]') as HTMLButtonElement).click()
    await flushUi()

    expect(mocks.telegramReplace).toHaveBeenCalledWith(17, '123456:another-synthetic-token')
    expect(mocks.telegramConnect).not.toHaveBeenCalled()
    expect(host.textContent).not.toContain('123456:another-synthetic-token')
  })

  it('取消 Telegram 接入不会发送 Token，验证失败也不回显输入值', async () => {
    mocks.list.mockResolvedValue({ items: [] })
    mocks.telegramConnect.mockRejectedValue(new Error('Telegram Bot Token 无效'))
    host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp(ProfileImPane)
    app.mount(host)
    await flushUi()

    ;(host.querySelector('[data-platform="telegram"] .pm-bind-btn') as HTMLButtonElement).click()
    await flushUi()
    let input = host.querySelector('#telegram-bot-token') as HTMLInputElement
    input.value = '123456:cancelled-synthetic-token'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    ;(host.querySelector('.pm-telegram-token-controls button[type="button"]') as HTMLButtonElement).click()
    await flushUi()
    expect(mocks.telegramConnect).not.toHaveBeenCalled()

    ;(host.querySelector('[data-platform="telegram"] .pm-bind-btn') as HTMLButtonElement).click()
    await flushUi()
    input = host.querySelector('#telegram-bot-token') as HTMLInputElement
    input.value = '123456:failed-synthetic-token'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    ;(host.querySelector('.pm-telegram-token-controls button[type="submit"]') as HTMLButtonElement).click()
    await flushUi()

    expect(mocks.telegramConnect).toHaveBeenCalledWith('123456:failed-synthetic-token')
    expect(host.textContent).not.toContain('123456:failed-synthetic-token')
    expect(host.textContent).toContain('Telegram Bot Token 无效')
  })

  it('收到 IM 频道状态事件后刷新 Telegram owner 绑定状态，不靠定时轮询', async () => {
    const unboundBot = { id: 17, platform: 'telegram', name: '@sample_bot', app_id: '9001', enabled: true, owner_bound: false }
    mocks.list.mockResolvedValueOnce({ items: [unboundBot] }).mockResolvedValueOnce({ items: [{ ...unboundBot, owner_bound: true }] })
    mocks.telegramBinding.mockResolvedValue({ code: '123456', expires_in: 600 })
    host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp(ProfileImPane)
    app.mount(host)
    await flushUi()

    ;(host.querySelector('[data-platform="telegram"] .pm-style-chip') as HTMLButtonElement).click()
    await flushUi()
    expect(host.textContent).toContain('/bind 123456')

    if (mocks.liveState) mocks.liveState.rev.im_channels++
    await flushUi()

    expect(mocks.list).toHaveBeenCalledTimes(2)
    expect(host.textContent).toContain('profileImUi.bound')
    expect(host.textContent).not.toContain('/bind 123456')
  })
})
