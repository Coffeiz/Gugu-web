// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive } from 'vue'
import { createPinia } from 'pinia'
import { i18n } from '@/i18n'

vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/stores/live', () => ({ useLiveStore: () => reactive({ resourceEvent: null, rev: { files: 0 } }) }))
vi.mock('@/components/common/viewers/TextViewer.vue', () => ({ default: { render: () => null } }))
vi.mock('@/components/common/viewers/ImageViewer.vue', () => ({ default: { render: () => null } }))
vi.mock('@/components/common/viewers/VideoViewer.vue', () => ({ default: { render: () => null } }))
vi.mock('@/components/common/viewers/OfficeViewer.vue', () => ({ default: { render: () => null } }))

import FloatPreviewWindow from '@/components/common/layout/FloatPreviewWindow.vue'

let app: ReturnType<typeof createApp> | undefined
let host: HTMLElement | undefined
afterEach(() => {
  app?.unmount()
  host?.remove()
  app = undefined
  host = undefined
  vi.unstubAllGlobals()
})

async function mountPreview() {
  const fetchMock = vi.fn().mockRejectedValue(new Error('测试不允许网络请求'))
  vi.stubGlobal('fetch', fetchMock)
  const win = reactive({
    id: 7, file: { id: 7, displayName: '示例文本', ext: 'TXT' },
    x: 50, y: 50, w: 480, h: 320, zIndex: 20001, _idx: 0, reloadToken: 0, siblings: [],
    sourceText: '隔离预览', saveSource: () => {},
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({ render: () => h(FloatPreviewWindow, { win }) })
  app.use(createPinia())
  app.use(i18n)
  app.mount(host)
  await nextTick()
  const root = host.querySelector<HTMLElement>('.fpw-root')!
  const title = root.querySelector<HTMLElement>('.fpw-title')!
  return { root, title, fetchMock }
}
async function drag(title: HTMLElement, clientX: number, clientY: number) {
  title.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 0, clientY: 0 }))
  window.dispatchEvent(new MouseEvent('mousemove', { clientX, clientY }))
  window.dispatchEvent(new MouseEvent('mouseup'))
  await nextTick()
}

describe('浮动预览窗保留实际拖动边界', () => {
  it('顶部始终可见，左右与底部允许 25% 额外视口范围', async () => {
    const { root, title, fetchMock } = await mountPreview()
    await drag(title, -100000, -100000)
    expect(parseFloat(root.style.left)).toBe(-window.innerWidth * 0.25)
    expect(parseFloat(root.style.top)).toBe(0)
    await drag(title, 100000, 100000)
    expect(parseFloat(root.style.left)).toBe(window.innerWidth * 1.25 - parseFloat(root.style.width))
    expect(parseFloat(root.style.top)).toBe(window.innerHeight * 1.25 - parseFloat(root.style.height))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('最大化后标题栏不启动拖动，恢复后可重新移动', async () => {
    const { root, title } = await mountPreview()
    title.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await nextTick()
    await drag(title, -100000, -100000)
    expect(root.style.left).toBe('0px')
    expect(root.style.top).toBe('0px')
    expect(root.style.width).toBe('100vw')
    title.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await nextTick()
    await drag(title, -100000, -100000)
    expect(parseFloat(root.style.left)).toBe(-window.innerWidth * 0.25)
  })
})
