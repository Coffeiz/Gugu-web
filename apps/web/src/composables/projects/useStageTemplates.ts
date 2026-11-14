import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePreferencesStore } from '@/stores/preferences'
import { localeRegistry, supportedLocales } from '@/i18n/registry'
import type { ProjectTodo } from '@/types/project'

type TemplateStage = string | { label?: string; todos?: unknown[]; [key: string]: unknown }
type StageTemplate = { id: string; name: string; stages: TemplateStage[]; [key: string]: unknown }
type BuiltinTranslationMatcher = (value: string, key: string) => boolean

const BUILTIN_TEMPLATE_KEYS = {
  default_1: {
    name: 'projects.templateStandard',
    stages: ['projects.defaultPlan', 'projects.defaultExecution', 'projects.defaultDelivery'],
  },
  default_2: {
    name: 'projects.templateIllustration',
    stages: ['projects.stageDraft', 'projects.stageLineart', 'projects.stageColoring', 'projects.defaultDelivery'],
  },
  default_3: {
    name: 'projects.templateAnimation',
    stages: ['projects.stageStoryboard', 'projects.stageKeyAnimation', 'projects.stageAnimation', 'projects.stagePostProduction', 'projects.defaultDelivery'],
  },
} as const

const getStageLabel = (stage: TemplateStage) => typeof stage === 'string' ? stage : stage.label ?? ''

type ProjectTranslationKey = keyof typeof localeRegistry['zh-CN']['projects']

export function isBuiltinTemplateTranslation(value: string, key: string): boolean {
  const prefix = 'projects.'
  if (!key.startsWith(prefix)) return false
  const translationKey = key.slice(prefix.length) as ProjectTranslationKey
  return supportedLocales.some(locale => localeRegistry[locale].projects[translationKey] === value)
}

export function localizeSavedBuiltinTemplates(
  templates: StageTemplate[],
  localizedDefaults: StageTemplate[],
  matchesBuiltinTranslation: BuiltinTranslationMatcher,
): StageTemplate[] {
  const localizedById = new Map(localizedDefaults.map(template => [template.id, template]))

  return templates.map(template => {
    const definition = BUILTIN_TEMPLATE_KEYS[template.id as keyof typeof BUILTIN_TEMPLATE_KEYS]
    const localized = localizedById.get(template.id)
    if (!definition || !localized) return template

    const name = matchesBuiltinTranslation(template.name, definition.name)
      ? localized.name
      : template.name
    const stages = template.stages.map(stage => {
      const keyIndex = definition.stages.findIndex(key => matchesBuiltinTranslation(getStageLabel(stage), key))
      if (keyIndex < 0) return stage

      const localizedStage = localized.stages[keyIndex]
      const localizedLabel = getStageLabel(localizedStage)
      if (!localizedLabel) return stage
      return typeof stage === 'string' ? localizedLabel : { ...stage, label: localizedLabel }
    })

    return { ...template, name, stages }
  })
}

const toStageObj = (s: string | { label?: string; todos?: unknown[] }): { label: string; todos: ProjectTodo[] } => typeof s === 'string'
  ? { label: s, todos: [] }
  : { label: s.label ?? '', todos: (s.todos ?? []) as ProjectTodo[] }

export function useStageTemplates() {
  const prefs = usePreferencesStore()
  const { t } = useI18n()

  const defaultTemplates = computed(() => [
    { id: 'default_1', name: t('projects.templateStandard'), stages: [t('projects.defaultPlan'), t('projects.defaultExecution'), t('projects.defaultDelivery')].map(toStageObj) },
    { id: 'default_2', name: t('projects.templateIllustration'), stages: [t('projects.stageDraft'), t('projects.stageLineart'), t('projects.stageColoring'), t('projects.defaultDelivery')].map(toStageObj) },
    { id: 'default_3', name: t('projects.templateAnimation'), stages: [t('projects.stageStoryboard'), t('projects.stageKeyAnimation'), t('projects.stageAnimation'), t('projects.stagePostProduction'), t('projects.defaultDelivery')].map(toStageObj) },
  ])

  const templates = computed(() => {
    if (!prefs.stageTemplates.length) return defaultTemplates.value
    return localizeSavedBuiltinTemplates(
      prefs.stageTemplates,
      defaultTemplates.value,
      isBuiltinTemplateTranslation,
    )
  })

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
