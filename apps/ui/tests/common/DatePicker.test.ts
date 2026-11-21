import { createApp, h, nextTick } from 'vue'
import { describe, expect, it } from 'vitest'
import { i18n } from '@/i18n'
import DatePicker from '@/components/common/controls/DatePicker.vue'
import { localDayKey } from '@/utils/dateAttribution'

describe('DatePicker 今天快捷入口', () => {
  it('今天没有出现在 allowed-dates 中时仍能跳转到今天', async () => {
    const today = localDayKey(new Date())
    const yesterday = localDayKey(new Date(Date.now() - 86400_000))
    let selectedDate = ''
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp({
      render: () => h(DatePicker, {
        allowedDates: [yesterday],
        max: today,
        showClear: false,
        'onUpdate:modelValue': (date: string) => { selectedDate = date },
      }),
    })
    app.use(i18n)
    app.mount(host)

    ;(host.querySelector('.dp-input') as HTMLElement).click()
    await nextTick()
    ;(document.body.querySelector('.dp-today') as HTMLButtonElement).click()

    expect(selectedDate).toBe(today)

    app.unmount()
    host.remove()
  })

  it('当前已经是今天时仍通知调用方重新定位', async () => {
    const today = localDayKey(new Date())
    let todayActionCount = 0
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp({
      render: () => h(DatePicker, {
        modelValue: today,
        max: today,
        'onUpdate:modelValue': () => {},
        onToday: () => { todayActionCount += 1 },
      }),
    })
    app.use(i18n)
    app.mount(host)

    ;(host.querySelector('.dp-input') as HTMLElement).click()
    await nextTick()
    ;(document.body.querySelector('.dp-today') as HTMLButtonElement).click()

    expect(todayActionCount).toBe(1)

    app.unmount()
    host.remove()
  })
})
