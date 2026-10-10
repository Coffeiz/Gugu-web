// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive } from 'vue'
import ImPlatformSettings from '@/views/Admin/Config/components/ImPlatformSettings.vue'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

let app: ReturnType<typeof createApp> | undefined
let host: HTMLDivElement | undefined

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = undefined
  host = undefined
})

describe('Admin IM 平台支持开关', () => {
  it('显示各平台当前状态，并只更新被切换的平台', async () => {
    const settings = reactive({ feishu: true, qq: true, wechat: true, telegram: true })
    host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp({
      setup: () => () => h(ImPlatformSettings, {
        modelValue: settings,
        'onUpdate:modelValue': (value: typeof settings) => Object.assign(settings, value),
      }),
    })
    app.mount(host)
    await nextTick()

    const switches = host.querySelectorAll<HTMLButtonElement>('.platform-row .toggle-switch')
    expect(switches).toHaveLength(4)
    expect(Array.from(switches).every(button => button.getAttribute('aria-pressed') === 'true')).toBe(true)

    switches[1].click()
    await nextTick()

    expect(settings).toEqual({ feishu: true, qq: false, wechat: true, telegram: true })
    expect(switches[1].getAttribute('aria-pressed')).toBe('false')
    expect(switches[0].getAttribute('aria-pressed')).toBe('true')
  })
})
