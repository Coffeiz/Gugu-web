import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, shallowRef } from 'vue'
import { fileWindowHitTestKey, useFileBrowserWindow, type WindowHitTest } from '@/composables/files/useFileBrowserWindow'
import type { FileMeta } from '@/stores/filesCache'
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
  const contents = ref({ folders: [{ id: 'f:1' }] as FolderCard[], files: Array.from({ length: amount }, (_, index) => ({ id: index + 1 })) as FileMeta[] })
  const hitTest = shallowRef<WindowHitTest | null>(null)
  const directoryKey = ref('root')
  let window!: ReturnType<typeof useFileBrowserWindow>
  const Browser = defineComponent({ setup(_, { slots }) { return () => h('div', { style: { gridTemplateColumns: '190px 190px 190px 190px 190px' } }, slots.default?.()) } })
  const app = createApp(defineComponent({
    setup() {
      window = useFileBrowserWindow(contents, mode, { tailCount: () => 1, resetKey: () => directoryKey.value })
      return () => h(Browser, { ref: window.browserRef, style: window.gridStyle.value }, {
        default: () => [...window.visibleFolders.value, ...window.visibleFiles.value].map(item => h('div', { class: 'card', 'data-layout-role': 'card', 'data-id': item.id })),
      })
    },
  }))
  app.provide(fileWindowHitTestKey, hitTest)
  app.mount(host)
  cleanups.push(() => { app.unmount(); scroll.remove() })
  await nextTick()
  await nextTick()
  return { scroll, host, contents, window, hitTest, directoryKey }
}

describe('文件浏览器窗口', () => {
  it('实时刷新不跳回顶部，切换目录才重置滚动位置', async () => {
    const { scroll, contents, directoryKey } = await mountWindow('grid')
    scroll.scrollTop = 5000
    scroll.dispatchEvent(new Event('scroll'))
    contents.value = { folders: [...contents.value.folders], files: [...contents.value.files] }
    await nextTick()
    expect(scroll.scrollTop).toBe(5000)
    directoryKey.value = 'next'
    await nextTick()
    expect(scroll.scrollTop).toBe(0)
  })
  it.each(['grid', 'list'] as const)('%s 大目录只挂载可见窗口，滚动可到达后续文件', async mode => {
    const { host, scroll, window } = await mountWindow(mode)
    expect(host.querySelectorAll('.card').length).toBeGreaterThan(1)
    expect(host.querySelectorAll('.card').length).toBeLessThan(100)
    expect(window.visibleFolders.value.map(item => item.id)).toEqual(['f:1'])
    scroll.scrollTop = 5000
    scroll.dispatchEvent(new Event('scroll'))
    await nextTick()
    expect(window.visibleFolders.value).toEqual([])
    expect(window.visibleFiles.value[0].id).toBeGreaterThan(50)
    expect(host.querySelectorAll('.card').length).toBeLessThan(100)
    expect(window.top.value).toBeGreaterThan(0)
    scroll.scrollTop = mode === 'grid' ? 146000 : 220000
    scroll.dispatchEvent(new Event('scroll'))
    await nextTick()
    expect(window.visibleFiles.value.at(-1)?.id).toBe(5000)
    expect(window.tailEnd.value).toBe(1)
    expect(window.bottom.value).toBe(0)
  })

  it('框选按完整网格坐标命中未挂载项目，文件夹与文件身份不混淆', async () => {
    const { hitTest, window } = await mountWindow('grid')
    expect(window.visibleFiles.value.some(item => item.id === 1000)).toBe(false)
    const result = hitTest.value!({ left: 0, top: 146 * 200, width: 190, height: 136 })!
    expect([...result.fileIds]).toEqual([1000])
    expect(result.folderIds.size).toBe(0)
    const first = hitTest.value!({ left: 0, top: 0, width: 190, height: 136 })!
    expect([...first.folderIds]).toEqual(['f:1'])
    expect(first.fileIds.size).toBe(0)
  })

  it('小目录保留完整自然布局，卸载时清理框选提供者', async () => {
    const { host, window, hitTest } = await mountWindow('grid', 5)
    expect(host.querySelectorAll('.card').length).toBe(6)
    expect(window.bottom.value).toBe(0)
    expect(hitTest.value!({ left: 0, top: 0, width: 190, height: 136 })).toBeNull()
    cleanups.splice(0).forEach(stop => stop())
    expect(hitTest.value).toBeNull()
  })
})
