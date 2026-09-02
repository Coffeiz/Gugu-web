import { defineStore } from 'pinia'
import { ref } from 'vue'
import { preferencesApi } from '@/services/api'
import { isSupportedLocale, setLocale, type SupportedLocale } from '@/i18n'
import { applyServerTheme } from '@/composables/core/useTheme'
import { InteractionSync } from '@/interaction/sync/InteractionSync'

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

  async function saveOptimistically<T>(key: string, payload: Record<string, unknown>, apply: () => void, rollback: () => void): Promise<void> {
    try {
      await InteractionSync.execute({
        scope: 'profile.preference.update',
        entityKey: `profile:preference:${key}`,
        apply,
        rollback,
        request: () => preferencesApi.update(payload as any),
      })
    } catch {
      // 保持原有偏好 API 的静默失败行为；本地状态已经由统一层回滚。
    }
  }

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
    const previous = locale.value
    const rollback = () => {
      locale.value = previous
      if (previous) setLocale(previous, true)
    }
    await saveOptimistically('locale', { locale: value }, () => {
      setLocale(value, true)
      locale.value = value
    }, rollback)
  }

  async function savePmStagesExpanded(v: boolean) {
    const previous = pmStagesExpanded.value
    await saveOptimistically('pmStagesExpanded', { pmStagesExpanded: v }, () => { pmStagesExpanded.value = v }, () => { pmStagesExpanded.value = previous })
  }

  async function saveCalendarDoneMode(v: string) {
    const previous = calendarDoneMode.value
    await saveOptimistically('calendarDoneMode', { calendarDoneMode: v }, () => { calendarDoneMode.value = v }, () => { calendarDoneMode.value = previous })
  }

  async function saveCalendarWeekStart(v: string) {
    const next = v === 'sunday' ? 'sunday' : 'monday'
    const previous = calendarWeekStart.value
    await saveOptimistically('calendarWeekStart', { calendarWeekStart: next }, () => { calendarWeekStart.value = next }, () => { calendarWeekStart.value = previous })
  }

  async function saveDefaultView(v: string) {
    const previous = defaultView.value
    await saveOptimistically('defaultView', { defaultView: v }, () => {
      defaultView.value = v
      localStorage.setItem('gugu-default-view', v)
    }, () => {
      defaultView.value = previous
      localStorage.setItem('gugu-default-view', previous)
    })
  }

  async function saveShellEnabled(v: boolean) {
    const previous = shellEnabled.value
    await saveOptimistically('shellEnabled', { shellEnabled: v }, () => { shellEnabled.value = v }, () => { shellEnabled.value = previous })
  }

  async function saveShellSystemEnabled(v: boolean) {
    const previous = shellSystemEnabled.value
    await saveOptimistically('shellSystemEnabled', { shellSystemEnabled: v }, () => { shellSystemEnabled.value = v }, () => { shellSystemEnabled.value = previous })
  }

  async function saveShellDangerousEnabled(v: boolean) {
    const previous = shellDangerousEnabled.value
    await saveOptimistically('shellDangerousEnabled', { shellDangerousEnabled: v }, () => { shellDangerousEnabled.value = v }, () => { shellDangerousEnabled.value = previous })
  }

  async function saveShellAutopilotEnabled(v: boolean) {
    const previous = shellAutopilotEnabled.value
    await saveOptimistically('shellAutopilotEnabled', { shellAutopilotEnabled: v }, () => { shellAutopilotEnabled.value = v }, () => { shellAutopilotEnabled.value = previous })
  }

  async function saveShowToolInteractions(v: boolean) {
    const previous = showToolInteractions.value
    await saveOptimistically('showToolInteractions', { showToolInteractions: v }, () => { showToolInteractions.value = v }, () => { showToolInteractions.value = previous })
  }

  async function saveToolInjectionMode(v: 'description' | 'full') {
    const next = v === 'full' ? 'full' : 'description'
    const previous = toolInjectionMode.value
    await saveOptimistically('toolInjectionMode', { toolInjectionMode: next }, () => { toolInjectionMode.value = next }, () => { toolInjectionMode.value = previous })
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
    const previous = { tone: replyTone.value, length: replyLength.value }
    const next = { tone: tone !== undefined ? tone : replyTone.value, length: length !== undefined ? length : replyLength.value }
    await saveOptimistically('style', { replyTone: next.tone, replyLength: next.length }, () => {
      replyTone.value = next.tone
      replyLength.value = next.length
    }, () => {
      replyTone.value = previous.tone
      replyLength.value = previous.length
    })
  }

  return {
    lastStages, stageTemplates, replyTone, replyLength, pmStagesExpanded, calendarWeekStart, calendarDoneMode, defaultView, shellEnabled, shellSystemEnabled, shellDangerousEnabled, shellAutopilotEnabled, showToolInteractions, toolInjectionMode, personalityPreference, personalityPreferenceEnabled, personalityPreferenceAvailable, personalityPreferenceRevision, locale,
    loaded, fetch, saveLocale, saveLastStages, saveTemplates, saveStyle, savePmStagesExpanded, saveCalendarWeekStart, saveCalendarDoneMode, saveDefaultView, saveShellEnabled, saveShellSystemEnabled, saveShellDangerousEnabled, saveShellAutopilotEnabled, saveShowToolInteractions, saveToolInjectionMode, savePersonalityPreference, uploadPersonalityFile,
  }
})
