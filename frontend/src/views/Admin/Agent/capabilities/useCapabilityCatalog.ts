import { ref } from 'vue'
import { useAdminStore } from '@/stores/admin'
import { i18n } from '@/i18n'

export interface CapabilityCatalogItem {
  name: string
  description_short: string
  category: string
  permissions: string[]
  platforms: string[]
  related_skills: string[]
  related_tools: string[]
  source: string
  enabled: boolean
}

export interface CapabilityCatalog {
  generation: number
  diagnostics: string[]
  tools: CapabilityCatalogItem[]
  skills: CapabilityCatalogItem[]
}

export function useCapabilityCatalog() {
  const t = i18n.global.t
  const adminStore = useAdminStore()
  const catalog = ref<CapabilityCatalog | null>(null)
  const loading = ref(false)
  const error = ref('')

  async function refresh() {
    loading.value = true
    error.value = ''
    try {
      const res = await adminStore.authFetch('/api/v1/admin/agent/capabilities')
      if (!res.ok) throw new Error(t('adminAgentUi.capabilityLoadFailedStatus', { status: res.status }))
      catalog.value = await res.json() as CapabilityCatalog
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : t('adminAgentUi.capabilityLoadFailed')
    } finally {
      loading.value = false
    }
  }

  return { catalog, loading, error, refresh }
}
