import { computed, onMounted, ref, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAdminStore } from '@/stores/admin'
import { browserTz } from '@/utils/dateAttribution'

export function useUsage(filters: { excludeDev: Ref<boolean>; includeByok: Ref<boolean>; date: Ref<string> }) {
  const { t } = useI18n()
  const adminStore = useAdminStore()
  const usage = ref<any | null>(null)
  const usageLoading = ref(false)
  const activeModel = ref<string | null>(null)
  const activeMetric = ref('calls')
  async function fetchUsage(model = activeModel.value) {
    usageLoading.value = true
    try {
      const params = new URLSearchParams({ timezone: browserTz() })
      if (model) params.set('model', model)
      if (filters.date.value) params.set('date', filters.date.value)
      if (filters.excludeDev.value) params.set('exclude_dev', 'true')
      if (filters.includeByok.value) params.set('include_byok', 'true')
      const res = await adminStore.authFetch(`/api/v1/admin/agent/usage?${params}`)
      if (!res.ok) throw new Error(`加载失败（${res.status}）`)
      usage.value = await res.json()
    }
    finally { usageLoading.value = false }
  }
  function fmtNum(n: number | null | undefined) { if (n == null) return '0'; if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`; if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`; return String(n) }
  const metrics = computed(() => [{ key: 'calls', label: t('adminUsageUi.calls'), unit: '次' }, { key: 'tokens_in', label: t('adminUsageUi.input'), unit: '' }, { key: 'tokens_out', label: t('adminUsageUi.output'), unit: '' }, { key: 'cache_ratio', label: t('adminUsageUi.cacheRate'), unit: '%' }, { key: 'cache_write', label: t('adminUsageUi.cacheWrite'), unit: '' }])
  function toggleModel(model: string) { activeModel.value = activeModel.value === model ? null : model; fetchUsage(activeModel.value) }
  onMounted(() => fetchUsage())
  watch([filters.excludeDev, filters.includeByok, filters.date], () => fetchUsage(activeModel.value))
  return { usage, usageLoading, activeModel, activeMetric, metrics, toggleModel, fmtNum }
}
