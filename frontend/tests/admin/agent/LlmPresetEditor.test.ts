// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, reactive } from 'vue'
import LlmPresetEditor from '@/views/Admin/Agent/llm/components/LlmPresetEditor.vue'

const mocks = vi.hoisted(() => ({ authFetch: vi.fn() }))

vi.mock('@/stores/admin', () => ({ useAdminStore: () => ({ authFetch: mocks.authFetch }) }))
vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

vi.mock('@/views/Admin/Agent/components/ProviderSelect.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/views/Admin/Agent/components/InterfaceTypeSelect.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/views/Admin/Agent/components/LocalCapabilityOverrides.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/common/controls/MultimodalCapabilities.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/AdminSelect.vue', () => ({ default: { template: '<div />' } }))

let app: ReturnType<typeof createApp> | undefined
let host: HTMLDivElement | undefined

async function flushUi() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  document.body.querySelector('.modal-mask')?.remove()
  app = undefined
  host = undefined
  mocks.authFetch.mockReset()
})

describe('LlmPresetEditor', () => {
  it('编辑模型名且新模型能力不支持通用思考开关时，说明仍保持显示', async () => {
    mocks.authFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ provider: 'openai-compatible', generic_thinking_toggle_supported: false }),
    })
    const draft = reactive({
      id: 1,
      name: '测试预设',
      provider: 'openai-compatible',
      api_key: '',
      base_url: 'https://example.invalid/v1',
      model: 'model-old',
      max_tokens: 1000,
      context_tokens: 4000,
      thinking: '',
      reasoning_persistence: 'off' as const,
      image: false,
      video: false,
      audio: false,
    })

    host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp(LlmPresetEditor, {
      draft,
      visible: true,
      isNew: false,
      saving: false,
      error: '',
      providers: [{ key: 'openai-compatible', label: 'OpenAI 兼容', base_url: '', model: '' }],
      imageDetailLevels: [],
      mediaDimensions: [],
      capabilityLoading: false,
      capabilityResults: {},
      modelLoading: false,
      modelError: '',
      modelMenuOpen: false,
      modelOptions: [],
      filteredModels: [],
      probingDim: null,
    })
    app.mount(host)
    await flushUi()

    const hint = () => document.body.querySelector('.thinking-hint')?.textContent
    expect(hint()).toContain('profileByokUi.genericThinkingHint')

    const modelInput = document.body.querySelector('.model-picker input') as HTMLInputElement
    modelInput.value = 'model-new'
    modelInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    expect(mocks.authFetch).toHaveBeenCalledTimes(2)
    expect(hint()).toContain('profileByokUi.genericThinkingHint')
  })
})
