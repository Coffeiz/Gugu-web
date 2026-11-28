// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, reactive, ref } from 'vue'

const mocks = vi.hoisted(() => ({ list: vi.fn() }))
const liveState = reactive({ rev: { im_channels: 0 } })

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
          access: { listBots: mocks.list, qr: { feishu: { start: vi.fn(), poll: vi.fn() } } },
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

it('慢扫码查询不重叠，取消后忽略在途成功响应', async () => {
  vi.useFakeTimers()
  try {
    const pending = Promise.withResolvers<{ status: string }>()
    const poll = vi.fn(() => pending.promise)
    const fetchSessions = vi.fn()
    let imConnect!: ReturnType<typeof useChatImConnect>
    app = createApp(defineComponent({
      setup() {
        imConnect = useChatImConnect({
          access: { listBots: mocks.list, qr: { wechat: { start: async () => ({ task_id: 'task', scan_url: 'https://example.com' }), poll } } },
          sidebarRef: ref(null), bindDialogRef: ref(null), expanded: ref(true), enterExpanded: vi.fn(), fetchSessions,
        })
        return () => h('div')
      },
    }))
    host = document.createElement('div')
    app.mount(host)
    await imConnect.startImConnect('wechat')
    await vi.advanceTimersByTimeAsync(9_000)
    expect(poll).toHaveBeenCalledExactlyOnceWith('task')
    imConnect.cancelImConnect()
    pending.resolve({ status: 'success' })
    await flushUi()
    expect(mocks.list).not.toHaveBeenCalled()
    expect(fetchSessions).not.toHaveBeenCalled()
  } finally { vi.useRealTimers() }
})
