import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { userSkillsApi, type SkillToolItem, type UserSkillItem, type UserSkillWrite } from '@/services/api'

export function useUserSkills() {
  const { t } = useI18n()
  const skills = ref<UserSkillItem[]>([])
  const tools = ref<SkillToolItem[]>([])
  const loading = ref(false)
  const saving = ref(false)
  const error = ref('')

  async function load() {
    loading.value = true
    error.value = ''
    try {
      const data = await userSkillsApi.list()
      skills.value = data.skills
      tools.value = data.tools
    } catch (err) {
      error.value = err instanceof Error ? err.message : t('skills.loadFailed')
    } finally {
      loading.value = false
    }
  }

  async function save(data: UserSkillWrite, editingSlug?: string) {
    saving.value = true
    error.value = ''
    try {
      if (editingSlug) {
        const { slug: _slug, ...patch } = data
        await userSkillsApi.update(editingSlug, patch)
      }
      else await userSkillsApi.create(data)
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
      await userSkillsApi.update(skill.slug, { enabled })
      skill.enabled = enabled
    } catch (err) {
      error.value = err instanceof Error ? err.message : t('skills.toggleFailed')
      throw err
    }
  }

  async function remove(skill: UserSkillItem) {
    error.value = ''
    try {
      await userSkillsApi.delete(skill.slug)
      await load()
    } catch (err) {
      error.value = err instanceof Error ? err.message : t('skills.deleteFailed')
      throw err
    }
  }

  return { skills, tools, loading, saving, error, load, save, toggle, remove }
}
