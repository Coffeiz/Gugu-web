import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, defineComponent, ref } from 'vue'
import { useChatWindow } from '@/components/common/gugu-chat/composables/useChatWindow'

vi.mock('@/stores/audio', () => ({ useAudioStore: () => ({ file: null }) }))
vi.mock('@/stores/ui', () => ({ useUiStore: () => ({}) }))
vi.mock('@/composables/core/windowz', () => ({ nextZ: () => 1, raisePopoversAbove: vi.fn() }))
vi.mock('@/services/sfx', () => ({ playGuguSfx: vi.fn() }))

describe('聊天窗口尺寸切换的底部锚点', () => {
  let wrapper: ReturnType<typeof createApp>
  let controls: ReturnType<typeof useChatWindow>
  let el: HTMLElement
  let height: number
  let total: number
  let rowStart: number
  let rowHeight: number
  let frames: Map<number, FrameRequestCallback>
  let nextFrame: number
  let notifyResize: (() => void) | null
  function frame() {
    const pending = [...frames.values()]
    frames.clear()
    pending.forEach(callback => callback(0))
  }
  beforeEach(() => {
    vi.useFakeTimers()
    frames = new Map()
    nextFrame = 0
    notifyResize = null
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { notifyResize = callback }
      observe() {}
      disconnect() { notifyResize = null }
    })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback)
      return nextFrame
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
    height = 200
    total = 1000
    rowStart = 600
    rowHeight = 200
    el = document.createElement('div')
    const row = document.createElement('div')
    row.className = 'msg-virtual-row'
    row.dataset.index = '3'
    el.append(row)
    Object.defineProperties(el, {
      clientHeight: { get: () => height },
      scrollHeight: { get: () => total },
    })
    el.getBoundingClientRect = () => ({ top: 0, bottom: height, height }) as DOMRect
    row.getBoundingClientRect = () => ({
      top: rowStart - el.scrollTop,
      bottom: rowStart + rowHeight - el.scrollTop,
      height: rowHeight,
    }) as DOMRect
    wrapper = createApp(defineComponent({
      setup() {
        controls = useChatWindow({
          windowRef: ref(document.createElement('div')),
          composerRef: ref(null),
          messagesEl: computed(() => el),
        })
        return () => null
      },
    }))
    wrapper.mount(document.createElement('div'))
  })
  afterEach(() => {
    wrapper.unmount()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('上翻后展开与缩小保持同一消息内的底部位置，不跳到末尾', () => {
    el.scrollTop = 500 // 视口底部在第 3 条消息的一半处。
    controls.markResizing()
    height = 350
    rowStart = 540
    rowHeight = 100
    frame()
    expect(el.scrollTop + height).toBe(rowStart + rowHeight / 2)
    height = 120
    rowStart = 360
    rowHeight = 300
    notifyResize?.()
    expect(el.scrollTop + height).toBe(rowStart + rowHeight / 2)
    expect(el.scrollTop + height).toBeLessThan(total)
  })

  it('原本在末尾时随文字换行后的内容高度保持末尾', () => {
    el.scrollTop = total - height
    controls.markResizing()
    total = 1500
    height = 150
    frame()
    expect(el.scrollTop + height).toBe(total)
    total = 800
    height = 400
    notifyResize?.()
    expect(el.scrollTop + height).toBe(total)
  })

  it('关闭窗口取消尺寸过渡的滚动调整', () => {
    el.scrollTop = 500
    controls.markResizing()
    frame()
    controls.closeChat()
    height = 350
    frame()
    notifyResize?.()
    expect(el.scrollTop).toBe(500)
    expect(controls.resizing.value).toBe(false)
  })
})
