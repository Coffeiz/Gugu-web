import { afterEach, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref } from 'vue'
import Terminals from './index.vue'

const api = vi.hoisted(() => ({ list: vi.fn(), events: vi.fn() }))
vi.mock('@/services/api', () => ({ terminalsApi: api }))
vi.mock('@/router', () => ({ default: { replace: vi.fn() } }))
vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }) }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: ref('zh-CN') }) }))
vi.mock('@/stores/live', () => ({ useLiveStore: () => ({ resourceEvent: null }) }))
vi.mock('@/composables/core/useConfirmDialog', () => ({ confirmDialog: vi.fn() }))
vi.mock('./components/InteractivePtyTerminal.vue', () => ({ default: { render: () => null } }))
vi.mock('@/components/common/controls/ActionButton.vue', () => ({ default: { render: () => null } }))
vi.mock('@/components/common/icons/Icon.vue', () => ({ default: { render: () => null } }))

let cleanup: (() => void) | undefined
afterEach(() => { cleanup?.(); vi.clearAllMocks() })

it('事件流持续连接时列表加载仍结束并展示终端', async () => {
  api.list.mockResolvedValue({ enabled: true, ptyEnabled: true, items: [{
    id: 'test-terminal', name: '测试终端', source: 'agent', mode: 'agent-events',
    status: 'running', outputChars: 0,
  }] })
  api.events.mockImplementation((_id, _cursor, signal: AbortSignal) => new Promise<void>(resolve => {
    signal.addEventListener('abort', () => resolve(), { once: true })
  }))
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(Terminals)
  cleanup = () => { app.unmount(); host.remove() }
  app.mount(host)
  expect(host.querySelector('[role="status"]')).not.toBeNull()
  await nextTick()
  await nextTick()
  expect(api.events).toHaveBeenCalledOnce()
  expect(host.querySelector('[role="status"]')).toBeNull()
  expect(host.querySelector('.terminal-item')?.textContent).toContain('测试终端')
})
