import { createApp, h } from 'vue'
import { describe, expect, it } from 'vitest'
import CloseButton from '@/components/common/overlays/CloseButton.vue'

describe('CloseButton', () => {
  it('紧凑模式保留卡片角落定位并将按钮图标缩至列表尺寸', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp({
      render: () => h(CloseButton, { title: '关闭', cardCorner: true, compact: true }),
    })
    app.mount(host)

    const button = host.querySelector('button') as HTMLButtonElement
    expect(button.classList.contains('app-close-button--card-corner')).toBe(true)
    expect(button.classList.contains('app-close-button--compact')).toBe(true)
    expect(button.querySelector('svg')?.getAttribute('width')).toBe('11')

    app.unmount()
    host.remove()
  })

  it('默认关闭按钮维持原尺寸，不受紧凑模式影响', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp({
      render: () => h(CloseButton, { title: '关闭', cardCorner: true }),
    })
    app.mount(host)

    const button = host.querySelector('button') as HTMLButtonElement
    expect(button.classList.contains('app-close-button--card-corner')).toBe(true)
    expect(button.classList.contains('app-close-button--compact')).toBe(false)
    expect(button.querySelector('svg')?.getAttribute('width')).toBe('14')

    app.unmount()
    host.remove()
  })
})
