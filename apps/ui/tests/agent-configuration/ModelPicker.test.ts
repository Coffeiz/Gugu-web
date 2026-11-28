// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, h } from 'vue'
import ModelPicker from '@/components/common/models/ModelPicker.vue'
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
let app: ReturnType<typeof createApp>
let host: HTMLDivElement
afterEach(() => { app?.unmount(); host?.remove() })
it('模型结果和错误保留在当前模型输入行下方的同一个列表中，不 Teleport 到页面外', () => {
  host = document.createElement('div')
  document.body.append(host)
  app = createApp({ render: () => h(ModelPicker, { open: true, error: '请先填写 API Key' }) })
  app.mount(host)
  const input = host.querySelector('input')!
  const list = host.querySelector('[role="listbox"]')!
  expect(list).not.toBeNull()
  expect(input.closest('.model-picker')?.contains(list)).toBe(true)
  expect(list.textContent).toContain('请先填写 API Key')
  expect(document.querySelectorAll('[role="listbox"]')).toHaveLength(1)
})
