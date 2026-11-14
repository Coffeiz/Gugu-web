import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { useMultimodalProbe } from '@/views/Admin/Agent/llm/useMultimodalProbe'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string, params?: Record<string, string>) => `${key}:${params?.message || params?.detail || ''}` }) }))
let scope: ReturnType<typeof effectScope>
afterEach(() => scope?.stop())
function setup(authFetch: ReturnType<typeof vi.fn>) {
  const target = ref({ id: 'test-preset', provider: 'openai', api_key: '', base_url: 'https://model.example.test', model: 'test-model', image: false })
  const showMsg = vi.fn()
  const showMsgParts = vi.fn()
  const probingDim = ref<string | null>(null)
  scope = effectScope()
  const probe = scope.run(() => useMultimodalProbe({ authFetch, target: () => target.value, presets: () => [], dimensions: () => [{ key: 'image', label: '图片' }], probingId: ref(null), probingDim, showMsg, showMsgParts }))!
  return { probe, target, showMsg, showMsgParts, probingDim }
}

describe('多模态检测反馈归属', () => {
  it('编辑器检测成功时只返回编辑器反馈并更新草稿，不把结果写到背后的列表', async () => {
    const { probe, target, showMsg } = setup(vi.fn().mockResolvedValue({ ok: true, json: async () => ({ supported: true }) }))
    await probe.probeMedia('test-preset', 'image')
    expect(probe.editorFeedback.value).toMatchObject({ isError: false })
    expect(probe.editorFeedback.value?.text).toContain('dimensionSupported')
    expect(target.value.image).toBe(true)
    expect(showMsg).not.toHaveBeenCalled()
  })

  it('失败响应保留在当前弹窗反馈中，不误改模型能力', async () => {
    const { probe, target, showMsg } = setup(vi.fn().mockResolvedValue({ ok: false, json: async () => ({ detail: '服务暂不可用' }) }))
    await probe.probeMedia('test-preset', 'image')
    expect(probe.editorFeedback.value).toMatchObject({ isError: true })
    expect(probe.editorFeedback.value?.text).toContain('服务暂不可用')
    expect(target.value.image).toBe(false)
    expect(showMsg).not.toHaveBeenCalled()
  })

  it('检测期间切换模型后，旧模型的结果不覆盖新草稿和反馈', async () => {
    let complete!: (value: unknown) => void
    const { probe, target } = setup(vi.fn(() => new Promise(resolve => { complete = resolve })))
    const work = probe.probeMedia('test-preset', 'image')
    target.value = { ...target.value, model: 'new-model' }
    await nextTick()
    complete({ ok: true, json: async () => ({ supported: true }) })
    await work
    expect(probe.editorFeedback.value).toBeNull()
    expect(target.value.image).toBe(false)
  })

  it('列表卡片检测仍将多维度结果交给列表反馈', async () => {
    const { probe, showMsgParts } = setup(vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: { image: { supported: false } } }) }))
    await probe.probeMedia('test-preset')
    expect(probe.editorFeedback.value).toBeNull()
    expect(showMsgParts).toHaveBeenCalledWith(expect.any(String), [expect.objectContaining({ key: 'image', status: 'unsupported' })])
  })
})
