import { defineStore } from 'pinia'
import { ref, type Ref } from 'vue'
import { preferencesApi } from '@/services/api'
import { isSupportedLocale, setLocale, type SupportedLocale } from '@/i18n'
import { applyServerTheme } from '@/composables/core/useTheme'
import { InteractionSync } from '@/interaction/sync/InteractionSync'

const AUTOMATIC_MODE_SYNC_KEY = 'gugu-automatic-mode-sync'

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
  const shellEnabled      = ref(true)
  const shellSystemEnabled = ref(false)
  const shellDangerousEnabled = ref(true)
  const automaticModeEnabled = ref(false)
  const decisionGuardEnabled = ref(false)
  const imToolDisplayMode = ref<'off' | 'all' | 'slow_only'>('all')
  const showIntermediateReplies = ref(false)
  const toolInjectionMode = ref<'description' | 'full'>('description')
  const customReplyStyle = ref('')
  const customReplyStyleEnabled = ref(false)
  const personalityPreference = ref('')
  const personalityPreferenceEnabled = ref(false)
  const personalityPreferenceAvailable = ref(true)
  const emailChangeEnabled = ref(false)
  const personalityPreferenceRevision = ref(0)
  const locale = ref<SupportedLocale | null>(null)
  const loaded            = ref(false)
  const automaticModeChannel = typeof BroadcastChannel === 'undefined'
    ? null
    : new BroadcastChannel('gugu_preferences')

  automaticModeChannel?.addEventListener('message', event => {
    if (event.data?.type !== 'automatic-mode-changed') return
    void refreshAutomaticModeEnabled()
  })
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', event => {
      if (event.key === AUTOMATIC_MODE_SYNC_KEY) void refreshAutomaticModeEnabled()
    })
  }

  async function saveOptimistically(key: string, payload: Record<string, unknown>, apply: () => void, rollback: () => void): Promise<boolean> {
    try {
      await InteractionSync.execute({
        scope: 'profile.preference.update',
        entityKey: `profile:preference:${key}`,
        apply,
        rollback,
        request: () => preferencesApi.update(payload as any),
      })
      return true
    } catch {
      // 保持原有偏好 API 的静默失败行为；本地状态已经由统一层回滚。
      return false
    }
  }

  async function savePreferenceValue<T>(key: string, target: Ref<T>, value: T) {
    const previous = target.value
    await saveOptimistically(key, { [key]: value }, () => { target.value = value }, () => { target.value = previous })
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
      shellEnabled.value     = (data as any).shellEnabled ?? true
      shellSystemEnabled.value = (data as any).shellSystemEnabled ?? false
      shellDangerousEnabled.value = (data as any).shellDangerousEnabled ?? true
      automaticModeEnabled.value = (data as any).automaticModeEnabled === true
      decisionGuardEnabled.value = (data as any).decisionGuardEnabled === true
      const displayMode = (data as any).imToolDisplayMode
      imToolDisplayMode.value = ['off', 'all', 'slow_only'].includes(displayMode) ? displayMode : 'all'
      showIntermediateReplies.value = (data as any).showIntermediateReplies ?? false
      toolInjectionMode.value = (data as any).toolInjectionMode === 'full' ? 'full' : 'description'
      customReplyStyle.value = data.customReplyStyle ?? ''
      customReplyStyleEnabled.value = data.customReplyStyleEnabled ?? false
      personalityPreference.value = data.personalityPreference ?? ''
      personalityPreferenceEnabled.value = data.personalityPreferenceEnabled ?? false
      personalityPreferenceAvailable.value = data.personalityPreferenceAvailable ?? true
      emailChangeEnabled.value = (data as any).emailChangeEnabled ?? false
      personalityPreferenceRevision.value = data.personalityPreferenceRevision ?? 0
      applyServerTheme((data as any).theme, (data as any).themeFamily, (data as any).palette)
      locale.value = isSupportedLocale(data.locale) ? data.locale : null
      if (locale.value) setLocale(locale.value, true)
      localStorage.setItem('gugu-default-view', defaultView.value)
      loaded.value = true
    } catch {}
  }

  async function refreshEmailChangeEnabled() {
    try {
      const data = await preferencesApi.get()
      emailChangeEnabled.value = data.emailChangeEnabled ?? false
    } catch {
      // 无法确认系统邮件能力时按不可用处理，避免展示无法提交的邮箱变更入口。
      emailChangeEnabled.value = false
    }
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
    await savePreferenceValue('pmStagesExpanded', pmStagesExpanded, v)
  }

  async function saveCalendarDoneMode(v: string) {
    await savePreferenceValue('calendarDoneMode', calendarDoneMode, v)
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
    await savePreferenceValue('shellEnabled', shellEnabled, v)
  }

  async function saveShellSystemEnabled(v: boolean) {
    await savePreferenceValue('shellSystemEnabled', shellSystemEnabled, v)
  }

  async function saveShellDangerousEnabled(v: boolean) {
    await savePreferenceValue('shellDangerousEnabled', shellDangerousEnabled, v)
  }

  async function saveAutomaticModeEnabled(v: boolean) {
    const previous = automaticModeEnabled.value
    const saved = await saveOptimistically('automaticModeEnabled', { automaticModeEnabled: v }, () => {
      automaticModeEnabled.value = v
    }, () => {
      automaticModeEnabled.value = previous
    })
    if (saved) {
      notifyAutomaticModeChanged()
    }
  }

  function notifyAutomaticModeChanged() {
    automaticModeChannel?.postMessage({ type: 'automatic-mode-changed' })
    try {
      localStorage.setItem(AUTOMATIC_MODE_SYNC_KEY, String(Date.now()))
    } catch {
      // BroadcastChannel 仍可用；隐私模式禁用 storage 时不影响服务端状态。
    }
  }

  async function refreshAutomaticModeEnabled(): Promise<boolean> {
    try {
      const data = await preferencesApi.get()
      automaticModeEnabled.value = data.automaticModeEnabled === true
      return true
    } catch {
      // 跨窗口刷新失败时保留上次已知状态，下一次变更会再次触发同步。
      return false
    }
  }

  async function saveDecisionGuardEnabled(v: boolean) {
    await savePreferenceValue('decisionGuardEnabled', decisionGuardEnabled, v)
  }

  async function saveShowIntermediateReplies(v: boolean) {
    await savePreferenceValue('showIntermediateReplies', showIntermediateReplies, v)
  }

  async function saveImToolDisplayMode(value: 'off' | 'all' | 'slow_only') {
    const previous = imToolDisplayMode.value
    await saveOptimistically('imToolDisplayMode', { imToolDisplayMode: value }, () => {
      imToolDisplayMode.value = value
    }, () => {
      imToolDisplayMode.value = previous
    })
  }

  async function saveToolInjectionMode(v: 'description' | 'full') {
    const next = v === 'full' ? 'full' : 'description'
    const previous = toolInjectionMode.value
    await saveOptimistically('toolInjectionMode', { toolInjectionMode: next }, () => { toolInjectionMode.value = next }, () => { toolInjectionMode.value = previous })
  }

  async function saveCustomReplyStyle(text: string) {
    const data = await preferencesApi.updateReplyStyle(text.trim() || null)
    customReplyStyle.value = data.customReplyStyle ?? ''
    return data
  }

  async function saveCustomReplyStyleEnabled(enabled: boolean) {
    const data = await preferencesApi.update({ customReplyStyleEnabled: enabled })
    customReplyStyle.value = data.customReplyStyle ?? ''
    customReplyStyleEnabled.value = data.customReplyStyleEnabled ?? false
    return data
  }

  async function uploadCustomReplyStyle(file: File) {
    const data = await preferencesApi.uploadReplyStyle(file)
    customReplyStyle.value = data.customReplyStyle ?? ''
    customReplyStyleEnabled.value = data.customReplyStyleEnabled ?? false
    return data
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
    lastStages, stageTemplates, replyTone, replyLength, pmStagesExpanded, calendarWeekStart, calendarDoneMode, defaultView, shellEnabled, shellSystemEnabled, shellDangerousEnabled, automaticModeEnabled, decisionGuardEnabled, imToolDisplayMode, showIntermediateReplies, toolInjectionMode, customReplyStyle, customReplyStyleEnabled, personalityPreference, personalityPreferenceEnabled, personalityPreferenceAvailable, personalityPreferenceRevision, emailChangeEnabled, locale,
    loaded, fetch, refreshAutomaticModeEnabled, notifyAutomaticModeChanged, refreshEmailChangeEnabled, saveLocale, saveLastStages, saveTemplates, saveStyle, savePmStagesExpanded, saveCalendarWeekStart, saveCalendarDoneMode, saveDefaultView, saveShellEnabled, saveShellSystemEnabled, saveShellDangerousEnabled, saveAutomaticModeEnabled, saveDecisionGuardEnabled, saveImToolDisplayMode, saveShowIntermediateReplies, saveToolInjectionMode, saveCustomReplyStyle, saveCustomReplyStyleEnabled, uploadCustomReplyStyle, savePersonalityPreference, uploadPersonalityFile,
  }
})
