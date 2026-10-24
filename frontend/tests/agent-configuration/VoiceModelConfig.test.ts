// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref } from 'vue'
import VoiceModelConfig from '@/views/Admin/Agent/runtime-config/components/VoiceModelConfig.vue'

const mock = vi.hoisted(() => ({ confirm: vi.fn(), deactivate: vi.fn() }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/composables/core/useConfirmDialog', () => ({ confirmDialog: mock.confirm }))
vi.mock('@/views/Admin/Agent/runtime-config/components/VoicePresetEditor.vue', () => ({ default: { render: () => null } }))
vi.mock('@/views/Admin/Agent/runtime-config/useVoicePresets', () => ({ useVoicePresets: () => ({
  items: ref([{ id: 'voice_test', name: '测试语音', provider: 'openai', model: 'test-asr', api_key: '', api_format: 'openai' }]),
  activeId: ref('voice_test'), loading: ref(false), saving: ref(false), testing: ref(false), activatingId: ref(''), deletingId: ref(''),
  error: ref(''), message: ref(''), messageIsError: ref(false), deactivate: mock.deactivate,
  fetchItems: vi.fn(), save: vi.fn(), activate: vi.fn(), remove: vi.fn(), test: vi.fn(), loadModels: vi.fn(), resetFeedback: vi.fn(),
}) }))
let app: ReturnType<typeof createApp>
let host: HTMLDivElement
beforeEach(() => { mock.confirm.mockReset(); mock.deactivate.mockReset() })
afterEach(() => { app?.unmount(); host?.remove() })

it.each([false, true])('关闭语音转写确认结果为 %s 时，仅在用户确认后停用', async confirmed => {
  mock.confirm.mockResolvedValue(confirmed)
  host = document.createElement('div')
  document.body.append(host)
  app = createApp({ render: () => h(VoiceModelConfig) })
  app.mount(host)
  const button = Array.from(host.querySelectorAll('button')).find(item => item.textContent === 'agentConfigUi.voiceDeactivate')!
  button.click()
  await Promise.resolve()
  await nextTick()
  expect(mock.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: 'agentConfigUi.voiceDeactivateMessage' }))
  expect(mock.deactivate).toHaveBeenCalledTimes(confirmed ? 1 : 0)
})
