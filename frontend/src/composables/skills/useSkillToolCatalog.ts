import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { userSkillsApi, type SkillToolItem } from '@/services/api'

export function useSkillToolCatalog() {
  const { t } = useI18n()
  const tools = ref<SkillToolItem[]>([])
  const loaded = ref(false)
  const loading = ref(false)
  const error = ref('')

  async function load(force = false) {
    if (loading.value || (loaded.value && !force)) return
    loading.value = true
    error.value = ''
    try {
      const data = await userSkillsApi.tools()
      tools.value = data.tools
      loaded.value = true
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : t('skills.toolsLoadFailed')
    } finally {
      loading.value = false
    }
  }

  return { tools, loaded, loading, error, load }
}
