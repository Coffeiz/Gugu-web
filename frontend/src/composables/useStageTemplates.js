import { computed } from 'vue'
import { usePreferencesStore } from '@/stores/preferences'

const DEFAULT_TEMPLATES = [
  { id: 'default_1', name: '标准流程',  stages: ['计划', '执行', '交付'] },
  { id: 'default_2', name: '插画流程',  stages: ['草稿', '线稿', '上色', '交付'] },
  { id: 'default_3', name: '动画流程',  stages: ['分镜', '原画', '动画', '后期', '交付'] },
]

export function useStageTemplates() {
  const prefs = usePreferencesStore()

  const templates = computed(() =>
    prefs.stageTemplates.length ? prefs.stageTemplates : DEFAULT_TEMPLATES
  )

  function _current() {
    return prefs.stageTemplates.length ? [...prefs.stageTemplates] : [...DEFAULT_TEMPLATES]
  }

  function applyTemplate(id) {
    return templates.value.find(t => t.id === id)?.stages ?? null
  }

  async function addTemplate(name, stages) {
    const trimmed = name.trim()
    if (!trimmed || !stages.length) return false
    const current = _current()
    const existing = current.find(t => t.name === trimmed)
    if (existing) {
      existing.stages = [...stages]
    } else {
      current.push({ id: `tpl_${Date.now()}`, name: trimmed, stages: [...stages] })
    }
    await prefs.saveTemplates(current)
    return true
  }

  async function removeTemplate(id) {
    await prefs.saveTemplates(_current().filter(t => t.id !== id))
  }

  async function renameTemplate(id, name) {
    const current = _current()
    const t = current.find(t => t.id === id)
    if (t) { t.name = name.trim(); await prefs.saveTemplates(current) }
  }

  return { templates, applyTemplate, addTemplate, removeTemplate, renameTemplate }
}
