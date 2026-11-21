import { ref } from 'vue'
import { useAdminStore } from '@/stores/admin'
import { i18n } from '@/i18n'

export type VoicePreset = {
  id: string
  name: string
  provider: 'openai' | 'qwen' | 'minimax' | 'local'
  api_key: string
  has_api_key: boolean
  base_url: string
  model: string
  api_format: 'openai' | 'dashscope' | 'minimax-asr'
  dashscope_service: 'qwen3-asr' | 'qwen-audio' | 'fun-asr'
  active: boolean
}

export type VoicePresetDraft = Omit<VoicePreset, 'id' | 'has_api_key' | 'active'> & { id?: string; has_api_key?: boolean }

export function useVoicePresets() {
  const adminStore = useAdminStore()
  const t = i18n.global.t
  const items = ref<VoicePreset[]>([])
  const activeId = ref('')
  const loading = ref(false)
  const saving = ref(false)
  const activatingId = ref('')
  const deletingId = ref('')
  const testing = ref(false)
  const error = ref('')
  const message = ref('')
  const messageIsError = ref(false)

  function report(text: string, isError = false) {
    message.value = text
    messageIsError.value = isError
    error.value = isError ? text : ''
  }

  async function request(path: string, init?: RequestInit) {
    const response = await adminStore.authFetch(`/api/v1/admin/agent${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.detail || t('adminAgentUi.operationFailed'))
    return data
  }

  function resetFeedback() {
    error.value = ''
    message.value = ''
    messageIsError.value = false
  }

  async function loadModels(draft: VoicePresetDraft): Promise<string[]> {
    const data = await request('/voice-presets/models-preview', {
      method: 'POST',
      body: JSON.stringify({ provider: draft.provider, base_url: draft.base_url, api_format: draft.api_format, api_key: draft.api_key, preset_id: draft.id || '' }),
    })
    return data.models
  }

  async function fetchItems(background = false): Promise<boolean> {
    if (!background) loading.value = true
    error.value = ''
    try {
      const data = await request('/voice-presets')
      items.value = Array.isArray(data.items) ? data.items : []
      activeId.value = String(data.active_id || '')
      return true
    } catch (cause) {
      report(cause instanceof Error ? cause.message : String(cause), true)
      return false
    } finally {
      if (!background) loading.value = false
    }
  }

  async function persist(path: string, method: string, successKey: string, body?: object): Promise<boolean> {
    error.value = ''
    try {
      await request(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) })
      if (!await fetchItems(true)) {
        report(t('agentConfigUi.voiceRefreshFailed'), true)
        return false
      }
      report(t(successKey))
      return true
    } catch (cause) {
      report(cause instanceof Error ? cause.message : String(cause), true)
      return false
    }
  }

  async function save(draft: VoicePresetDraft): Promise<boolean> {
    saving.value = true
    try {
      const { id, has_api_key: _hasApiKey, active: _active, ...body } = draft as VoicePresetDraft & Partial<VoicePreset>
      return await persist(id ? `/voice-presets/${encodeURIComponent(id)}` : '/voice-presets', id ? 'PUT' : 'POST', 'agentConfigUi.voicePresetSaved', body)
    } finally {
      saving.value = false
    }
  }

  async function changeActivation(id: string) {
    activatingId.value = id || 'off'
    try {
      return await persist(id ? `/voice-presets/${encodeURIComponent(id)}/activate` : '/voice-presets/deactivate', 'POST', id ? 'agentConfigUi.voiceActivated' : 'agentConfigUi.voiceDeactivated')
    } finally {
      activatingId.value = ''
    }
  }

  async function remove(id: string) {
    deletingId.value = id
    try {
      return await persist(`/voice-presets/${encodeURIComponent(id)}`, 'DELETE', 'agentConfigUi.voiceDeleted')
    } finally {
      deletingId.value = ''
    }
  }

  async function test(draft: VoicePresetDraft): Promise<boolean> {
    testing.value = true
    error.value = ''
    try {
      const { id, has_api_key: _hasApiKey, active: _active, ...body } = draft as VoicePresetDraft & Partial<VoicePreset>
      const data = await request('/voice-presets/test', {
        method: 'POST',
        body: JSON.stringify({ ...body, preset_id: id || '' }),
      })
      if (!data.ok) throw new Error(data.message || t('adminRuntimeUi.testFailed', { status: '' }))
      report(data.message || t('adminRuntimeUi.voiceConnected'))
      return true
    } catch (cause) {
      report(cause instanceof Error ? cause.message : String(cause), true)
      return false
    } finally {
      testing.value = false
    }
  }

  return { items, activeId, loading, saving, activatingId, deletingId, testing, error, message, messageIsError, fetchItems, save, activate: changeActivation, deactivate: () => changeActivation(''), remove, test, loadModels, resetFeedback }
}
