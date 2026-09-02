import { defineStore } from 'pinia'
import { ref } from 'vue'
import { preferencesApi } from '@/services/api'
import { isSupportedLocale, setLocale, type SupportedLocale } from '@/i18n'
import { applyServerTheme } from '@/composables/useTheme'

export const usePreferencesStore = defineStore('preferences', () => {
  // 偏好里的松结构数组（阶段/模板元素类型待后端入 OpenAPI 后 gen:types 收紧），暂 any[]
  const lastStages       = ref<any[]>([])
  const stageTemplates   = ref<any[]>([])
  const replyTone        = ref<string | null>(null)   // natural(null) / formal / lively
  const replyLength      = ref<string | null>(null)   // medium(null) / short / detailed
  const pmStagesExpanded  = ref(false)  // 项目编辑卡阶段区展开版面记忆
  const calendarWeekStart = ref('monday') // 'monday' 或 'sunday'
  const calendarDoneMode  = ref('done') // 'done' = 已完成项目显示到完成日；'deadline' = 显示到截止日
  const defaultView       = ref(localStorage.getItem('gugu-default-view') ?? 'projects')
  const shellEnabled      = ref(false)
  const shellSystemEnabled = ref(false)
  const shellDangerousEnabled = ref(false)
  const shellAutopilotEnabled = ref(false)
  const showToolInteractions = ref(false)
  const toolInjectionMode = ref<'description' | 'full'>('full')
  const personalityPreference = ref('')
  const personalityPreferenceEnabled = ref(false)
  const personalityPreferenceAvailable = ref(true)
  const personalityPreferenceRevision = ref(0)
  const locale = ref<SupportedLocale | null>(null)
  const loaded            = ref(false)

  async function fetch() {
    try {
      const data = await preferencesApi.get()
      lastStages.value       = data.lastStages     ?? []
      stageTemplates.value   = data.stageTemplates ?? []
      replyTone.value        = data.replyTone      ?? null
      replyLength.value      = data.replyLength    ?? null
      pmStagesExpanded.value = data.pmStagesExpanded ?? false
      calendarWeekStart.value = (data as any).calendarWeekStart ?? 'monday'
      calendarDoneMode.value = (data as any).calendarDoneMode ?? 'done'   // 类型待后端 calendarDoneMode 入 OpenAPI 后 gen:types 收回
      defaultView.value      = (data as any).defaultView ?? 'projects'
      shellEnabled.value     = (data as any).shellEnabled ?? false
      shellSystemEnabled.value = (data as any).shellSystemEnabled ?? false
      shellDangerousEnabled.value = (data as any).shellDangerousEnabled ?? false
      shellAutopilotEnabled.value = (data as any).shellAutopilotEnabled ?? false
      showToolInteractions.value = (data as any).showToolInteractions ?? false
      toolInjectionMode.value = (data as any).toolInjectionMode === 'description' ? 'description' : 'full'
      personalityPreference.value = data.personalityPreference ?? ''
      personalityPreferenceEnabled.value = data.personalityPreferenceEnabled ?? false
      personalityPreferenceAvailable.value = data.personalityPreferenceAvailable ?? true
      personalityPreferenceRevision.value = data.personalityPreferenceRevision ?? 0
      applyServerTheme((data as any).theme, (data as any).themeFamily, (data as any).palette)
      locale.value = isSupportedLocale(data.locale) ? data.locale : null
      if (locale.value) setLocale(locale.value, true)
      localStorage.setItem('gugu-default-view', defaultView.value)
      loaded.value = true
    } catch {}
  }

  async function saveLocale(value: SupportedLocale) {
    setLocale(value, true)
    locale.value = value
    try { await preferencesApi.update({ locale: value }) } catch {}
  }

  async function savePmStagesExpanded(v: boolean) {
    pmStagesExpanded.value = v
    try { await preferencesApi.update({ pmStagesExpanded: v }) } catch {}
  }

  async function saveCalendarDoneMode(v: string) {
    calendarDoneMode.value = v
    try { await preferencesApi.update({ calendarDoneMode: v } as any) } catch {}
  }

  async function saveCalendarWeekStart(v: string) {
    calendarWeekStart.value = v === 'sunday' ? 'sunday' : 'monday'
    try { await preferencesApi.update({ calendarWeekStart: calendarWeekStart.value } as any) } catch {}
  }

  async function saveDefaultView(v: string) {
    defaultView.value = v
    localStorage.setItem('gugu-default-view', v)
    try { await preferencesApi.update({ defaultView: v } as any) } catch {}
  }

  async function saveShellEnabled(v: boolean) {
    shellEnabled.value = v
    try { await preferencesApi.update({ shellEnabled: v } as any) } catch {}
  }

  async function saveShellSystemEnabled(v: boolean) {
    shellSystemEnabled.value = v
    try { await preferencesApi.update({ shellSystemEnabled: v } as any) } catch {}
  }

  async function saveShellDangerousEnabled(v: boolean) {
    shellDangerousEnabled.value = v
    try { await preferencesApi.update({ shellDangerousEnabled: v } as any) } catch {}
  }

  async function saveShellAutopilotEnabled(v: boolean) {
    shellAutopilotEnabled.value = v
    try { await preferencesApi.update({ shellAutopilotEnabled: v } as any) } catch {}
  }

  async function saveShowToolInteractions(v: boolean) {
    showToolInteractions.value = v
    try { await preferencesApi.update({ showToolInteractions: v } as any) } catch {}
  }

  async function saveToolInjectionMode(v: 'description' | 'full') {
    toolInjectionMode.value = v === 'full' ? 'full' : 'description'
    try { await preferencesApi.update({ toolInjectionMode: toolInjectionMode.value } as any) } catch {}
  }

  async function savePersonalityPreference(text: string, enabled: boolean) {
    const data = await preferencesApi.update({
      personalityPreference: text.trim() || null,
      personalityPreferenceEnabled: enabled,
    })
    personalityPreference.value = data.personalityPreference ?? ''
    personalityPreferenceEnabled.value = data.personalityPreferenceEnabled ?? false
    personalityPreferenceAvailable.value = data.personalityPreferenceAvailable ?? true
    personalityPreferenceRevision.value = data.personalityPreferenceRevision ?? 0
    return data
  }

  async function uploadPersonalityFile(file: File) {
    const data = await preferencesApi.uploadPersonality(file)
    personalityPreference.value = data.personalityPreference ?? ''
    personalityPreferenceEnabled.value = data.personalityPreferenceEnabled ?? false
    personalityPreferenceAvailable.value = data.personalityPreferenceAvailable ?? true
    personalityPreferenceRevision.value = data.personalityPreferenceRevision ?? 0
    return data
  }

  async function saveLastStages(stages: any[]) {
    lastStages.value = stages
    try { await preferencesApi.update({ lastStages: stages }) } catch {}
  }

  async function saveTemplates(templates: any[]) {
    stageTemplates.value = templates
    try { await preferencesApi.update({ stageTemplates: templates }) } catch {}
  }

  async function saveStyle({ tone, length }: { tone?: string | null; length?: string | null }) {
    if (tone      !== undefined) replyTone.value   = tone
    if (length    !== undefined) replyLength.value = length
    try {
      await preferencesApi.update({
        replyTone:   replyTone.value,
        replyLength: replyLength.value,
      })
    } catch {}
  }

  return {
    lastStages, stageTemplates, replyTone, replyLength, pmStagesExpanded, calendarWeekStart, calendarDoneMode, defaultView, shellEnabled, shellSystemEnabled, shellDangerousEnabled, shellAutopilotEnabled, showToolInteractions, toolInjectionMode, personalityPreference, personalityPreferenceEnabled, personalityPreferenceAvailable, personalityPreferenceRevision, locale,
    loaded, fetch, saveLocale, saveLastStages, saveTemplates, saveStyle, savePmStagesExpanded, saveCalendarWeekStart, saveCalendarDoneMode, saveDefaultView, saveShellEnabled, saveShellSystemEnabled, saveShellDangerousEnabled, saveShellAutopilotEnabled, saveShowToolInteractions, saveToolInjectionMode, savePersonalityPreference, uploadPersonalityFile,
  }
})
