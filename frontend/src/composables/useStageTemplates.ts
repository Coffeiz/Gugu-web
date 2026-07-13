import { computed } from 'vue'
import { usePreferencesStore } from '@/stores/preferences'

const toStageObj = (s: string | { label?: string; todos?: unknown[] }) => typeof s === 'string' ? { label: s, todos: [] } : { label: s.label ?? '', todos: s.todos ?? [] }

const DEFAULT_TEMPLATES = [
  { id: 'default_1', name: '标准流程',  stages: ['计划', '执行', '交付'].map(toStageObj) },
  { id: 'default_2', name: '插画流程',  stages: ['草稿', '线稿', '上色', '交付'].map(toStageObj) },
  { id: 'default_3', name: '动画流程',  stages: ['分镜', '原画', '动画', '后期', '交付'].map(toStageObj) },
]

export function useStageTemplates() {
  const prefs = usePreferencesStore()

  const templates = computed(() =>
    prefs.stageTemplates.length ? prefs.stageTemplates : DEFAULT_TEMPLATES
  )

  function _current() {
    return prefs.stageTemplates.length ? [...prefs.stageTemplates] : [...DEFAULT_TEMPLATES]
  }

  function applyTemplate(id: string) {
    const stages = templates.value.find(t => t.id === id)?.stages ?? null
    if (!stages) return null
    return stages.map(toStageObj)
  }

  async function addTemplate(name: string, stages: Array<string | { label?: string; todos?: unknown[] }>) {
    const trimmed = name.trim()
    if (!trimmed || !stages.length) return false
    const normalized = stages.map(toStageObj)
    const current = _current()
    const existing = current.find(t => t.name === trimmed)
    if (existing) {
      existing.stages = normalized
    } else {
      current.push({ id: `tpl_${Date.now()}`, name: trimmed, stages: normalized })
    }
    await prefs.saveTemplates(current)
    return true
  }

  async function removeTemplate(id: string) {
    await prefs.saveTemplates(_current().filter(t => t.id !== id))
  }

  async function renameTemplate(id: string, name: string) {
    const current = _current()
    const t = current.find(t => t.id === id)
    if (t) { t.name = name.trim(); await prefs.saveTemplates(current) }
  }

  return { templates, applyTemplate, addTemplate, removeTemplate, renameTemplate }
}
