import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import { useFileBrowserWindow } from '@/composables/files/useFileBrowserWindow'
import type { FolderCard } from '@/utils/filesNav'

const cleanups: Array<() => void> = []
afterEach(() => { cleanups.splice(0).forEach(stop => stop()); vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function mountWindow(mode: 'grid' | 'list', amount = 5000) {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    const height = this.classList.contains('card') ? (mode === 'grid' ? 136 : 42) : 500
    return { x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: height, width: 1000, height, toJSON() {} } as DOMRect
  })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(500)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1000)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000)
  const scroll = document.createElement('div')
  scroll.className = 'scroll-surface'
  const host = document.createElement('div')
  scroll.append(host)
  document.body.append(scroll)
  const contents = ref({ folders: Array.from({ length: amount }, (_, index) => ({
    id: `personal:${index}`, type: 'disk-personal', displayName: `目录${index}`, count: null,
    relativePath: `目录${index}`,
  })) as FolderCard[] })
  const directoryKey = ref('root')
  let window!: ReturnType<typeof useFileBrowserWindow>
  const Browser = defineComponent({ setup(_, { slots }) { return () => h('div', { style: { gridTemplateColumns: '190px 190px 190px 190px 190px' } }, slots.default?.()) } })
  const app = createApp(defineComponent({
    setup() {
      window = useFileBrowserWindow(contents, mode, { resetKey: () => directoryKey.value })
      return () => h(Browser, { ref: window.browserRef, style: window.gridStyle.value }, {
        default: () => window.visibleFolders.value.map(item => h('div', { class: 'card', 'data-layout-role': 'card', 'data-path': item.relativePath })),
      })
    },
  }))
  app.mount(host)
  cleanups.push(() => { app.unmount(); scroll.remove() })
  await nextTick()
  await nextTick()
  return { scroll, host, contents, window, directoryKey }
}

describe('文件浏览器目录窗口', () => {
  it('目录内容刷新保留滚动位置，切换路径才回到顶部', async () => {
    const { scroll, contents, directoryKey } = await mountWindow('grid')
    scroll.scrollTop = 5000
    scroll.dispatchEvent(new Event('scroll'))
    contents.value = { folders: [...contents.value.folders] }
    await nextTick()
    expect(scroll.scrollTop).toBe(5000)
    directoryKey.value = 'personal:子目录'
    await nextTick()
    expect(scroll.scrollTop).toBe(0)
  })

  it.each(['grid', 'list'] as const)('%s 视图对大量磁盘目录只挂载可见窗口', async mode => {
    const { host, scroll, window } = await mountWindow(mode)
    expect(host.querySelectorAll('.card').length).toBeGreaterThan(1)
    expect(host.querySelectorAll('.card').length).toBeLessThan(100)
    expect(window.visibleFolders.value[0]?.relativePath).toBe('目录0')
    scroll.scrollTop = 5000
    scroll.dispatchEvent(new Event('scroll'))
    await nextTick()
    expect(window.visibleFolders.value[0]?.relativePath).not.toBe('目录0')
    expect(host.querySelectorAll('.card').length).toBeLessThan(100)
    expect(window.top.value).toBeGreaterThan(0)
  })
})
