// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import VoiceModelConfig from '@/views/Admin/Agent/runtime-config/components/VoiceModelConfig.vue'

const mock = vi.hoisted(() => ({ authFetch: vi.fn() }))
vi.mock('@/stores/admin', () => ({ useAdminStore: () => mock }))
vi.mock('@/i18n', () => ({ i18n: { global: { t: (key: string) => key } } }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/composables/core/useConfirmDialog', () => ({ confirmDialog: vi.fn().mockResolvedValue(true) }))
vi.mock('@/views/Admin/Agent/runtime-config/components/VoicePresetEditor.vue', () => ({ default: { render: () => null } }))
let app: ReturnType<typeof createApp>
let host: HTMLDivElement
beforeEach(() => mock.authFetch.mockReset())
afterEach(() => { app?.unmount(); host?.remove() })
const response = (active: string) => ({ ok: true, json: async () => ({ active_id: active, items: [{ id: 'voice_test', name: '测试语音', provider: 'openai', model: 'test-model', api_key: '', api_format: 'openai' }] }) })
async function flush() { await Promise.resolve(); await nextTick(); await Promise.resolve(); await nextTick() }

it.each([true, false])('语音模型初始启用状态为 %s 时，启停请求和后台刷新期间保留同一张卡片', async active => {
  let finish!: (response: unknown) => void
  mock.authFetch.mockResolvedValueOnce(response(active ? 'voice_test' : '')).mockResolvedValueOnce({ ok: true, json: async () => ({}) }).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  host = document.createElement('div')
  document.body.append(host)
  app = createApp({ render: () => h(VoiceModelConfig) })
  app.mount(host)
  await flush()
  const card = host.querySelector('article')!
  const button = Array.from(host.querySelectorAll('button')).find(item => item.textContent === (active ? 'agentConfigUi.voiceDeactivate' : 'agentConfigUi.voiceUse'))!
  button.click()
  await flush()
  expect(mock.authFetch).toHaveBeenCalledTimes(3)
  expect(host.querySelector('article')).toBe(card)
  expect(host.textContent).not.toContain('agent.loading')
  finish(response(active ? '' : 'voice_test'))
  await flush()
  expect(host.querySelector('article')).toBe(card)
  expect(host.textContent?.includes('agent.current')).toBe(!active)
})
