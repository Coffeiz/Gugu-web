import { ref } from 'vue'
import { useAdminStore } from '@/stores/admin'
import { i18n } from '@/i18n'

export interface PromptProfile { profile: string }
export interface PromptPlaceholder { key: string; desc: string }

export function usePromptConfig() {
  const t = i18n.global.t
  const adminStore = useAdminStore()
  const activeProfile = ref('default')
  const profiles = ref<PromptProfile[]>([])
  const placeholders = ref<PromptPlaceholder[]>([])
  const promptContent = ref('')
  const promptSaving = ref(false)
  const promptSaved = ref(false)
  const promptError = ref('')
  const promptCache: Record<string, string> = {}

  async function loadPrompt(profile: string) {
    if (promptCache[profile] !== undefined) {
      promptContent.value = promptCache[profile]
      return
    }
    try {
      const res = await adminStore.authFetch(`/api/v1/admin/agent/prompts/${encodeURIComponent(profile)}`)
      if (!res.ok) throw new Error(t('adminAgentUi.loadFailedStatus', { status: res.status }))
      const data = await res.json()
      promptCache[profile] = data.content || ''
      promptContent.value = promptCache[profile]
    } catch (error) {
      promptError.value = t('adminAgentUi.loadFailed', { message: error instanceof Error ? error.message : String(error) })
    }
  }

  async function refreshProfiles() {
    try {
      const res = await adminStore.authFetch('/api/v1/admin/agent/prompts')
      if (!res.ok) throw new Error(t('adminAgentUi.loadFailedStatus', { status: res.status }))
      const data = await res.json()
      profiles.value = data.profiles || []
      placeholders.value = data.placeholders || []
      await loadPrompt(activeProfile.value)
    } catch (error) {
      promptError.value = t('adminAgentUi.loadFailed', { message: error instanceof Error ? error.message : String(error) })
    }
  }

  async function switchProfile(profile: string) {
    promptCache[activeProfile.value] = promptContent.value
    activeProfile.value = profile
    promptError.value = ''
    await loadPrompt(profile)
  }

  function insertPlaceholder(key: string, textarea: HTMLTextAreaElement | null) {
    if (!textarea) return
    const start = textarea.selectionStart ?? promptContent.value.length
    const end = textarea.selectionEnd ?? start
    promptContent.value = promptContent.value.slice(0, start) + key + promptContent.value.slice(end)
    requestAnimationFrame(() => {
      textarea.focus()
      const caret = start + key.length
      textarea.setSelectionRange(caret, caret)
    })
  }

  async function savePrompt() {
    promptSaving.value = true
    promptSaved.value = false
    promptError.value = ''
    try {
      const res = await adminStore.authFetch(`/api/v1/admin/agent/prompts/${encodeURIComponent(activeProfile.value)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: promptContent.value }),
      })
      if (!res.ok) throw new Error(t('adminAgentUi.saveFailedStatus', { status: res.status }))
      promptCache[activeProfile.value] = promptContent.value
      promptSaved.value = true
      setTimeout(() => { promptSaved.value = false }, 3000)
    } catch (error) {
      promptError.value = error instanceof Error ? error.message : String(error)
      setTimeout(() => { promptError.value = '' }, 5000)
    } finally {
      promptSaving.value = false
    }
  }

  return { activeProfile, profiles, placeholders, promptContent, promptSaving, promptSaved, promptError, refreshProfiles, switchProfile, insertPlaceholder, savePrompt }
}
