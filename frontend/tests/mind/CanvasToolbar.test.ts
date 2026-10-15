// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick } from 'vue'

const { refSuggest } = vi.hoisted(() => ({ refSuggest: vi.fn() }))

vi.mock('@/services/api', () => ({ mindApi: { refSuggest } }))
vi.mock('vue-i18n', async importOriginal => ({
  ...await importOriginal<typeof import('vue-i18n')>(),
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('@/components/common/overlays/PopupMenu.vue', () => ({
  default: defineComponent({
    props: ['show'],
    setup(_props, { slots }) {
      return () => h('div', slots.default?.())
    },
  }),
}))

import CanvasToolbar from '@/views/Mind/components/CanvasToolbar.vue'

let app: ReturnType<typeof createApp> | undefined
let host: HTMLDivElement | undefined

function mountToolbar(onAddRef: (item: unknown) => void) {
  host = document.createElement('div')
  document.body.append(host)
  app = createApp(CanvasToolbar, { scale: 1, items: [], onAddRef })
  app.mount(host)
  return host
}

async function flushUi() {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = undefined
  host = undefined
  refSuggest.mockReset()
})

describe('画布对象选择器', () => {
  it('只展示可加入画布的项目、文件和活动，选择后发出添加事件', async () => {
    const onAddRef = vi.fn()
    const results = [
      { type: 'folder', id: 2325, label: '音乐', subtitle: '个人 · 音乐' },
      { type: 'project', id: 12, label: '音乐项目', subtitle: '客户 A' },
      { type: 'file', id: 34, label: '音乐.mp3', subtitle: '个人' },
      { type: 'event', id: 56, label: '音乐会', subtitle: '2026-10-12' },
      { type: 'conversation', id: 78, label: '音乐讨论' },
    ]
    refSuggest.mockResolvedValue(results)
    const root = mountToolbar(onAddRef)

    root.querySelector<HTMLButtonElement>('.canvas-toolbar button:nth-child(2)')?.click()
    const search = root.querySelector<HTMLInputElement>('.np-search')!
    search.value = '音乐'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    expect([...root.querySelectorAll('.np-note strong')].map(item => item.textContent)).toEqual([
      '音乐项目', '音乐.mp3', '音乐会',
    ])
    root.querySelector<HTMLButtonElement>('.np-note')?.click()
    expect(onAddRef).toHaveBeenCalledWith(results[1])
  })

  it('搜索结果只有不支持类型时显示空结果状态', async () => {
    refSuggest.mockResolvedValue([
      { type: 'folder', id: 2325, label: '音乐' },
      { type: 'conversation', id: 78, label: '音乐讨论' },
    ])
    const root = mountToolbar(vi.fn())

    root.querySelector<HTMLButtonElement>('.canvas-toolbar button:nth-child(2)')?.click()
    const search = root.querySelector<HTMLInputElement>('.np-search')!
    search.value = '音乐'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    expect(root.querySelectorAll('.np-note')).toHaveLength(0)
    expect(root.querySelector('.np-empty')?.textContent).toBe('mindUi.noObjects')
  })
})
