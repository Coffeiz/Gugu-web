// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive } from 'vue'
import { createPinia } from 'pinia'
import { i18n } from '@/i18n'
import { pathFileAccessKey } from '@/services/pathFileAccess'
import { desktopPathFileAccess } from '@desktop/files/pathFileAccess'

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
  localStorage.removeItem('gugu-preview-size-floating')
})

async function mountPreview(ext = 'TXT') {
  const fetchMock = vi.fn().mockRejectedValue(new Error('测试不允许网络请求'))
  vi.stubGlobal('fetch', fetchMock)
  const win = reactive({
    id: 7, file: { id: 7, displayName: '示例文件', ext },
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

it('桌面图片使用本地文件身份读取，读取失败仍显示预览窗口和错误', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 404 }))
  vi.stubGlobal('fetch', fetchMock)
  const win = {
    id: 7, file: { displayName: 'sample.png', ext: 'PNG', workspaceFile: {
      directoryId: 'personal', relativePath: 'sample.png', identity: 'sample-identity',
    } },
    x: 0, y: 0, w: 480, h: 320, zIndex: 1, _idx: 0, reloadToken: 0, siblings: [],
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({ render: () => h(FloatPreviewWindow, { win, nativeWindow: true }) })
  app.provide(pathFileAccessKey, desktopPathFileAccess)
  app.use(createPinia()).use(i18n).mount(host)
  await vi.waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('identity=sample-identity'), expect.anything())
    expect(host?.querySelector('.fpw-native.fpw-ready .fpw-error')?.textContent).toContain('HTTP 404')
  })
})

it('手动调整后打开另一种格式，保留窗口尺寸', async () => {
  const { root } = await mountPreview()
  const initialWidth = parseFloat(root.style.width)
  const initialHeight = parseFloat(root.style.height)
  await drag(root.querySelector<HTMLElement>('.fpw-resize')!, 60, -24)
  expect(parseFloat(root.style.width)).toBe(initialWidth + 60)
  expect(parseFloat(root.style.height)).toBe(initialHeight - 24)
  app?.unmount()
  host?.remove()
  const next = await mountPreview('PNG')
  expect(parseFloat(next.root.style.width)).toBe(initialWidth + 60)
  expect(parseFloat(next.root.style.height)).toBe(initialHeight - 24)
})
