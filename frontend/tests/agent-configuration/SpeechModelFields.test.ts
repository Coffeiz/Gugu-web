// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, reactive, ref } from 'vue'
import SpeechModelFields from '@/components/common/models/SpeechModelFields.vue'
import { speechProviderDefaults } from '@/utils/speechModelConfig'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/views/Admin/Agent/components/ProviderSelect.vue', () => ({ default: defineComponent({
  props: ['providers'], emits: ['update:modelValue'],
  setup: (props, { emit }) => () => h('div', props.providers.map((item: {key: string}) => h('button', { onClick: () => emit('update:modelValue', item.key) }, item.key))),
}) }))
vi.mock('@/components/common/overlays/PopupMenu.vue', () => ({ default: defineComponent({
  props: ['show'], setup: (props, { slots }) => () => props.show ? h('div', slots.default?.()) : null,
}) }))
let app: ReturnType<typeof createApp>
let host: HTMLDivElement

afterEach(() => { app?.unmount(); host?.remove() })
function mount(loadModels = async () => ['test-asr-model']) {
  const draft = reactive(speechProviderDefaults('openai'))
  const key = ref('temporary-key')
  host = document.createElement('div')
  document.body.append(host)
  app = createApp({ render: () => h(SpeechModelFields, {
    draft, apiKey: key.value, keepKey: true, loadModels,
    'onUpdate:apiKey': (value: string) => { key.value = value },
  }) })
  app.mount(host)
  return { draft, key }
}
function click(text: string) {
  const button = Array.from(host.querySelectorAll('button')).find(item => item.textContent === text)
  expect(button).toBeTruthy()
  button!.click()
}
async function flush() { await Promise.resolve(); await nextTick(); await Promise.resolve(); await nextTick() }

describe('Admin 与 BYOK 共用语音连接表单', () => {
  it('切换服务商更新语音协议与默认值，并清除不能用于新目的地的草稿 Key', async () => {
    const { draft, key } = mount()
    click('minimax')
    await nextTick()
    expect(draft).toMatchObject({ provider: 'minimax', api_format: 'minimax-asr', model: 'asr-1.0' })
    expect(key.value).toBe('')
    const url = host.querySelector<HTMLInputElement>('[aria-label="llmExtraUi.baseUrl"]')!
    url.value = 'https://speech.example.test'
    url.dispatchEvent(new Event('input'))
    expect(draft.base_url).toBe('https://speech.example.test')
  })

  it('千问语音可以显式切换原生和兼容接口，协议与地址一起进入同一个草稿', async () => {
    const { draft } = mount()
    click('qwen')
    await nextTick()
    expect(draft.api_format).toBe('dashscope')
    click('profileByokUi.chatCompletions')
    expect(draft.api_format).toBe('openai')
    expect(draft.base_url).toContain('/compatible-mode/v1')
  })

  it('旧连接的模型列表迟到时，不覆盖用户已经切换的新连接', async () => {
    let finish!: (models: string[]) => void
    mount(() => new Promise(resolve => { finish = resolve }))
    click('profileByokUi.getModels')
    click('minimax')
    await nextTick()
    finish(['old-provider-model'])
    await flush()
    expect(host.textContent).not.toContain('old-provider-model')
    expect(host.querySelector<HTMLInputElement>('[aria-label="adminLlmUi.modelName"]')!.value).toBe('asr-1.0')
  })

  it('从模型列表选择的值写回当前草稿，供两种保存接口提交', async () => {
    const { draft } = mount()
    draft.model = ''
    click('profileByokUi.getModels')
    await flush()
    click('test-asr-model')
    expect(draft.model).toBe('test-asr-model')
  })
})
