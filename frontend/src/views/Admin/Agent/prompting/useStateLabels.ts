import { computed, reactive, ref } from 'vue'
import { useAdminStore } from '@/stores/admin'
import { showAppError } from '@/composables/useAppToast'
import { i18n } from '@/i18n'

export interface StateLabelRow { key: string; default: string; custom: string }

export function useStateLabels() {
  const t = i18n.global.t
  const adminStore = useAdminStore()
  const stateLabels = reactive<{ special: StateLabelRow[]; tools: StateLabelRow[] }>({ special: [], tools: [] })
  const labelsLoading = ref(false)
  const labelsSaving = ref(false)
  const labelsFilter = ref('')
  const labelsSaved = ref(false)
  const filteredTools = computed(() => {
    const query = labelsFilter.value.trim().toLowerCase()
    if (!query) return stateLabels.tools
    return stateLabels.tools.filter(row => row.key.toLowerCase().includes(query) || row.default.toLowerCase().includes(query) || row.custom.toLowerCase().includes(query))
  })

  async function refresh() {
    labelsLoading.value = true
    try {
      const res = await adminStore.authFetch('/api/v1/admin/agent/state-labels')
      if (!res.ok) throw new Error(t('adminAgentUi.loadFailedStatus', { status: res.status }))
      const data = await res.json()
      stateLabels.special = (data.special || []).map((row: StateLabelRow) => ({ ...row }))
      stateLabels.tools = (data.tools || []).map((row: StateLabelRow) => ({ ...row }))
    } catch {
      showAppError(t('adminAgentUi.loadRetry'))
    } finally {
      labelsLoading.value = false
    }
  }

  async function save() {
    labelsSaving.value = true
    labelsSaved.value = false
    try {
      const overrides: Record<string, string> = {}
      for (const row of [...stateLabels.special, ...stateLabels.tools]) {
        const value = (row.custom || '').trim()
        if (value && value !== row.default) overrides[row.key] = value
      }
      const res = await adminStore.authFetch('/api/v1/admin/agent/state-labels', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ overrides }),
      })
      if (!res.ok) throw new Error(t('adminAgentUi.saveFailed'))
      labelsSaved.value = true
      setTimeout(() => { labelsSaved.value = false }, 2000)
    } catch {
      showAppError(t('adminAgentUi.saveRetry'))
    } finally {
      labelsSaving.value = false
    }
  }

  function reset(row: StateLabelRow) { row.custom = '' }
  return { stateLabels, labelsLoading, labelsSaving, labelsFilter, labelsSaved, filteredTools, refresh, save, reset }
}
