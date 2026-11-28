import { skillAccessKey } from '@/services/resourceAccess'
import { inject, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { userSkillsApi, type FileSkillPatch, type UserSkillItem, type UserSkillWrite } from '@/services/api'
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
        const patch: FileSkillPatch = {}
        if (data.name !== editing.name) patch.name = data.name
        if (data.description_short !== editing.description_short) patch.description = data.description_short
        if ((data.description_long ?? null) !== editing.description_long) patch.descriptionLong = data.description_long ?? null
        if (data.category !== editing.category) patch.category = data.category
        if (data.body !== editing.body) patch.body = data.body
        if (data.enabled !== undefined && data.enabled !== editing.enabled) patch.enabled = data.enabled
        if (data.related_tools.length !== editing.related_tools.length || data.related_tools.some(tool => !editing.related_tools.includes(tool)))
          patch.relatedTools = data.related_tools
        if (Object.keys(patch).length) await api.updateFileSkill(editing.id, editing.content_digest, patch, editing.storage_source)
      } else await api.createFileSkill(data)
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
      await api.updateFileSkill(skill.id, skill.content_digest, { enabled }, skill.storage_source)
      await load()
    } catch (err) {
      error.value = err instanceof Error ? err.message : t('skills.toggleFailed')
      throw err
    }
  }

  async function remove(skill: UserSkillItem) {
    error.value = ''
    try {
      await api.deleteFileSkill(skill.id, skill.content_digest, skill.storage_source)
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
