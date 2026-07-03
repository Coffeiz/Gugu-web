import { defineStore } from 'pinia'
import { ref } from 'vue'
import { preferencesApi } from '@/services/api'

export const usePreferencesStore = defineStore('preferences', () => {
  const lastStages       = ref([])
  const stageTemplates   = ref([])
  const replyTone        = ref(null)   // natural(null) / formal / lively
  const replyLength      = ref(null)   // medium(null) / short / detailed
  const pmStagesExpanded  = ref(false)  // 项目编辑卡阶段区展开版面记忆
  const calendarDoneMode  = ref('done') // 'done' = 已完成项目显示到完成日；'deadline' = 显示到截止日
  const loaded            = ref(false)

  async function fetch() {
    try {
      const data = await preferencesApi.get()
      lastStages.value       = data.lastStages     ?? []
      stageTemplates.value   = data.stageTemplates ?? []
      replyTone.value        = data.replyTone      ?? null
      replyLength.value      = data.replyLength    ?? null
      pmStagesExpanded.value = data.pmStagesExpanded ?? false
      calendarDoneMode.value = (data as any).calendarDoneMode ?? 'done'   // 类型待后端 calendarDoneMode 入 OpenAPI 后 gen:types 收回
      loaded.value = true
    } catch {}
  }

  async function savePmStagesExpanded(v) {
    pmStagesExpanded.value = v
    try { await preferencesApi.update({ pmStagesExpanded: v }) } catch {}
  }

  async function saveCalendarDoneMode(v) {
    calendarDoneMode.value = v
    try { await preferencesApi.update({ calendarDoneMode: v } as any) } catch {}
  }

  async function saveLastStages(stages) {
    lastStages.value = stages
    try { await preferencesApi.update({ lastStages: stages }) } catch {}
  }

  async function saveTemplates(templates) {
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
    lastStages, stageTemplates, replyTone, replyLength, pmStagesExpanded, calendarDoneMode,
    loaded, fetch, saveLastStages, saveTemplates, saveStyle, savePmStagesExpanded, saveCalendarDoneMode,
  }
})
