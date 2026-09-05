import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePreferencesStore } from '@/stores/preferences'

const toStageObj = (s: string | { label?: string; todos?: unknown[] }) => typeof s === 'string' ? { label: s, todos: [] } : { label: s.label ?? '', todos: s.todos ?? [] }

export function useStageTemplates() {
  const prefs = usePreferencesStore()
  const { t } = useI18n()

  const defaultTemplates = computed(() => [
    { id: 'default_1', name: t('projects.templateStandard'), stages: [t('projects.defaultPlan'), t('projects.defaultExecution'), t('projects.defaultDelivery')].map(toStageObj) },
    { id: 'default_2', name: t('projects.templateIllustration'), stages: [t('projects.stageDraft'), t('projects.stageLineart'), t('projects.stageColoring'), t('projects.defaultDelivery')].map(toStageObj) },
    { id: 'default_3', name: t('projects.templateAnimation'), stages: [t('projects.stageStoryboard'), t('projects.stageKeyAnimation'), t('projects.stageAnimation'), t('projects.stagePostProduction'), t('projects.defaultDelivery')].map(toStageObj) },
  ])

  const templates = computed(() =>
    prefs.stageTemplates.length ? prefs.stageTemplates : defaultTemplates.value
  )

  function _current() {
    if (prefs.stageTemplates.length) return [...prefs.stageTemplates]
    return defaultTemplates.value.map(template => ({
      ...template,
      stages: template.stages.map(stage => ({ ...stage, todos: [...(stage.todos ?? [])] })),
    }))
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
