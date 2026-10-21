// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useVoicePresets, type VoicePresetDraft } from '@/views/Admin/Agent/runtime-config/useVoicePresets'

const mock = vi.hoisted(() => ({ authFetch: vi.fn() }))
vi.mock('@/stores/admin', () => ({ useAdminStore: () => mock }))
vi.mock('@/i18n', () => ({ i18n: { global: { t: (key: string) => key } } }))
const response = (body: unknown, ok = true) => ({ ok, json: async () => body })
const draft: VoicePresetDraft = { id: 'voice_test', name: '测试语音', provider: 'openai', api_key: '', base_url: 'https://speech.example.test', model: 'draft', api_format: 'openai', dashscope_service: 'qwen3-asr', has_api_key: true }

beforeEach(() => mock.authFetch.mockReset())

describe('平台语音预设持久化', () => {
  it('保存后重新读取服务端权威列表与启用项，且不提交界面凭据标记', async () => {
    mock.authFetch.mockResolvedValueOnce(response({})).mockResolvedValueOnce(response({
      active_id: 'voice_test', items: [{ ...draft, model: 'normalized' }],
    }))
    const voice = useVoicePresets()
    expect(await voice.save({ ...draft })).toBe(true)
    const [url, init] = mock.authFetch.mock.calls[0]
    expect(url).toBe('/api/v1/admin/agent/voice-presets/voice_test')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body)).not.toHaveProperty('has_api_key')
    expect(voice.items.value[0].model).toBe('normalized')
    expect(voice.activeId.value).toBe('voice_test')
    expect(voice.saving.value).toBe(false)
  })

  it('保存失败保留当前草稿并显示服务端错误，结束保存中状态', async () => {
    mock.authFetch.mockResolvedValue(response({ detail: '请重新填写 API Key' }, false))
    const voice = useVoicePresets()
    const editing = { ...draft }
    expect(await voice.save(editing)).toBe(false)
    expect(editing).toEqual(draft)
    expect(voice.error.value).toBe('请重新填写 API Key')
    expect(voice.saving.value).toBe(false)
    expect(mock.authFetch).toHaveBeenCalledTimes(1)
  })
})
