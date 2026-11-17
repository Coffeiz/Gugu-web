import { ref } from 'vue'
import { useAdminStore } from '@/stores/admin'

export function useDatabaseInitialization() {
  const loading = ref(false)
  const adminStore = useAdminStore()

  async function initialize() {
    if (loading.value) return { ok: false, message: '' }
    loading.value = true
    try {
      const response = await adminStore.authFetch('/api/v1/admin/config/init-db', { method: 'POST' })
      const result = await response.json()
      if (!response.ok) return { ok: false, message: result.detail || result.message || `数据库初始化失败（${response.status}）` }
      return result
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    } finally {
      loading.value = false
    }
  }

  return { loading, initialize }
}
