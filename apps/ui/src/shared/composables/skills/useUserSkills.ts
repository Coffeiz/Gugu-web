import { skillAccessKey } from '@/services/resourceAccess'
import { inject, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { userSkillsApi, type UserSkillItem, type UserSkillWrite } from '@/services/api'
import { RESOURCE_REFRESH_EVENTS } from '@/services/resourceRefreshEvents'
import { useSkillToolCatalog } from './useSkillToolCatalog'

export function useUserSkills() {
  const { t } = useI18n()
  const api = inject(skillAccessKey, null)?.api ?? userSkillsApi
  const skills = ref<UserSkillItem[]>([])
  const toolCatalog = useSkillToolCatalog()
  const loaded = ref(false)
  const loading = ref(false)
  const saving = ref(false)
  const error = ref('')

  const onMcpChanged = () => {
    void load()
    if (toolCatalog.loaded.value) void toolCatalog.load(true)
  }
  onMounted(() => window.addEventListener(RESOURCE_REFRESH_EVENTS.mcp, onMcpChanged))
  onBeforeUnmount(() => window.removeEventListener(RESOURCE_REFRESH_EVENTS.mcp, onMcpChanged))

  async function load() {
    loading.value = true
    error.value = ''
    try {
      const data = await api.list()
      skills.value = data.skills
      loaded.value = true
    } catch (err) {
      error.value = err instanceof Error ? err.message : t('skills.loadFailed')
    } finally {
      loading.value = false
    }
  }

  async function save(data: UserSkillWrite, editing?: UserSkillItem | null) {
    saving.value = true
    error.value = ''
    try {
      if (editing) {
        const { related_tools, ...fields } = data
        const previous = new Set(editing.related_tools)
        const changed = previous.size !== related_tools.length || related_tools.some(name => !previous.has(name))
        await api.update(editing.id, changed ? { ...fields, related_tools } : fields)
      } else await api.create(data)
      await load()
    } catch (err) {
      error.value = err instanceof Error ? err.message : t('skills.saveFailed')
      throw err
    } finally {
      saving.value = false
    }
  }

  async function toggle(skill: UserSkillItem) {
    error.value = ''
    const enabled = !skill.enabled
    try {
      // 状态开关只更新当前卡片，避免整页 loading 让卡片短暂卸载。
      await api.update(skill.id, { enabled })
      skill.enabled = enabled
    } catch (err) {
      error.value = err instanceof Error ? err.message : t('skills.toggleFailed')
      throw err
    }
  }

  async function remove(skill: UserSkillItem) {
    error.value = ''
    try {
      await api.delete(skill.id)
      await load()
    } catch (err) {
      error.value = err instanceof Error ? err.message : t('skills.deleteFailed')
      throw err
    }
  }

  return {
    skills,
    tools: toolCatalog.tools,
    toolsLoaded: toolCatalog.loaded,
    toolsLoading: toolCatalog.loading,
    toolsError: toolCatalog.error,
    loaded, loading, saving, error, load, loadTools: toolCatalog.load, save, toggle, remove,
  }
}
