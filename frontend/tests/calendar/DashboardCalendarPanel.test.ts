// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h } from 'vue'
import { browserDayKey } from '@/utils/dateAttribution'

const state = vi.hoisted(() => ({
  events: [] as Array<Record<string, unknown>>,
  projects: [] as Array<Record<string, unknown>>,
  list: vi.fn(),
  update: vi.fn(),
  fetchUpcomingCalEvents: vi.fn(),
  showAppError: vi.fn(),
}))

vi.mock('@/services/api', () => ({ eventsApi: { list: state.list, update: state.update } }))
vi.mock('@/stores/projects', () => ({
  useProjectStore: () => ({
    projects: state.projects,
    get upcomingCalEvents() { return state.events },
    fetchUpcomingCalEvents: state.fetchUpcomingCalEvents,
  }),
}))
vi.mock('@/stores/ui', () => ({ useUiStore: () => ({}) }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/composables/shared/useHolidays', () => ({
  useHolidays: () => ({ fetchYear: vi.fn().mockResolvedValue([]), getHolidayType: () => null }),
}))
vi.mock('@/components/common/controls/DatePicker.vue', () => ({ default: { render: () => null } }))
vi.mock('@/composables/core/useAppToast', () => ({ showAppError: state.showAppError }))

import CalendarPanel from '@/views/Dashboard/components/CalendarPanel.vue'

let app: ReturnType<typeof createApp> | undefined
let host: HTMLDivElement | undefined

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = undefined
  host = undefined
  state.events = []
  state.projects = []
  vi.clearAllMocks()
})

function tomorrowIso() {
  const date = new Date()
  date.setDate(date.getDate() + 1)
  return browserDayKey(date)
}

describe('Dashboard 日历快捷编辑', () => {
  it('提交打开弹窗时的版本，遇到并发更新后提示、回滚并刷新缓存', async () => {
    const original = {
      id: 81, title: '原活动', date: tomorrowIso(), type: 'event', version: 7, description: '旧描述',
    }
    state.events = [{ ...original }]
    state.list.mockResolvedValue([{ ...original }])
    state.fetchUpcomingCalEvents.mockImplementation(async () => {
      state.events = [{ ...original, title: '另一端新标题', version: 8 }]
    })
    state.update.mockRejectedValue(Object.assign(new Error('冲突'), { status: 409 }))

    host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp({ render: () => h(CalendarPanel) })
    app.mount(host)

    await vi.waitFor(() => expect(host?.querySelector('.cap-capsule')).not.toBeNull())
    host.querySelector<HTMLElement>('.cap-capsule')?.click()
    await vi.waitFor(() => expect(document.body.querySelector('.dash-popup-save')).not.toBeNull())
    const title = document.body.querySelector<HTMLInputElement>('.dash-popup-input')!
    title.value = '我的旧草稿'
    title.dispatchEvent(new Event('input', { bubbles: true }))
    document.body.querySelector<HTMLButtonElement>('.dash-popup-save')?.click()

    await vi.waitFor(() => expect(state.update).toHaveBeenCalledOnce())
    expect(state.update.mock.calls[0][0]).toBe(81)
    expect(state.update.mock.calls[0][1]).toMatchObject({ title: '我的旧草稿', version: 7 })
    await vi.waitFor(() => expect(state.showAppError).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(state.fetchUpcomingCalEvents).toHaveBeenCalledOnce())
    expect(state.events[0]).toMatchObject({ title: '另一端新标题', version: 8 })
  })
})
