// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, reactive, ref } from 'vue'

const mocks = vi.hoisted(() => ({ list: vi.fn() }))
const liveState = reactive({ rev: { im_channels: 0 } })

vi.mock('@/services/api', () => ({
  userBotsApi: { list: mocks.list },
  feishuConnectApi: { start: vi.fn(), poll: vi.fn() },
  qqConnectApi: { start: vi.fn(), poll: vi.fn() },
  wechatConnectApi: { start: vi.fn(), poll: vi.fn() },
  telegramConnectApi: { connect: vi.fn() },
}))
vi.mock('@/stores/live', () => ({ useLiveStore: () => liveState }))
vi.mock('@/i18n', () => ({ i18n: { global: { t: (key: string) => key } } }))
vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn() } }))

import { useChatImConnect } from '@/components/common/gugu-chat/composables/useChatImConnect'

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
  liveState.rev.im_channels = 0
})

describe('GuguChat IM 状态同步', () => {
  it('个人设置变更 IM 绑定后会重新读取侧栏 Bot 状态', async () => {
    mocks.list
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ items: [{ id: 7, platform: 'feishu', enabled: true }] })

    let imConnect!: ReturnType<typeof useChatImConnect>
    const component = defineComponent({
      setup() {
        imConnect = useChatImConnect({
          sidebarRef: ref(null) as never,
          bindDialogRef: ref(null) as never,
          expanded: ref(false),
          enterExpanded: vi.fn(),
          fetchSessions: vi.fn(),
        })
        return () => h('div')
      },
    })
    host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp(component)
    app.mount(host)

    await imConnect.loadBots()
    expect(imConnect.botsOf('feishu')).toHaveLength(0)

    liveState.rev.im_channels++
    await vi.waitFor(() => expect(imConnect.botsOf('feishu')).toHaveLength(1))
    await flushUi()
    expect(mocks.list).toHaveBeenCalledTimes(2)
  })
})
