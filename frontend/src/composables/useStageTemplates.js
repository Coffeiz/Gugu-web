import { usePreferencesStore } from '@/stores/preferences'

const DEFAULT_TEMPLATES = [
  { id: 'default_1', name: '标准流程',  stages: ['计划', '执行', '交付'] },
  { id: 'default_2', name: '插画流程',  stages: ['草稿', '线稿', '上色', '交付'] },
  { id: 'default_3', name: '动画流程',  stages: ['分镜', '原画', '动画', '后期', '交付'] },
]

export function useStageTemplates() {
  const prefs = usePreferencesStore()

  const templates = prefs.stageTemplates.length
    ? prefs.stageTemplates
    : DEFAULT_TEMPLATES

  // 返回响应式引用（直接用 store 的 ref）
  const templatesRef = {
    get value() {
      return prefs.stageTemplates.length ? prefs.stageTemplates : DEFAULT_TEMPLATES
    }
  }

  function applyTemplate(id) {
    const list = prefs.stageTemplates.length ? prefs.stageTemplates : DEFAULT_TEMPLATES
    return list.find(t => t.id === id)?.stages ?? null
  }

  async function addTemplate(name, stages) {
    const trimmed = name.trim()
    if (!trimmed || !stages.length) return false
    const current = prefs.stageTemplates.length ? [...prefs.stageTemplates] : [...DEFAULT_TEMPLATES]
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
    const current = prefs.stageTemplates.length ? [...prefs.stageTemplates] : [...DEFAULT_TEMPLATES]
    const filtered = current.filter(t => t.id !== id)
    await prefs.saveTemplates(filtered)
  }

  async function renameTemplate(id, name) {
    const current = prefs.stageTemplates.length ? [...prefs.stageTemplates] : [...DEFAULT_TEMPLATES]
    const t = current.find(t => t.id === id)
    if (t) {
      t.name = name.trim()
      await prefs.saveTemplates(current)
    }
  }

  return { templates: templatesRef, applyTemplate, addTemplate, removeTemplate, renameTemplate }
}
