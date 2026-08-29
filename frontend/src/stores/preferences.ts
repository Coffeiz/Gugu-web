import { defineStore } from 'pinia'
import { ref } from 'vue'
import { preferencesApi } from '@/services/api'

export const usePreferencesStore = defineStore('preferences', () => {
  // 偏好里的松结构数组（阶段/模板元素类型待后端入 OpenAPI 后 gen:types 收紧），暂 any[]
  const lastStages       = ref<any[]>([])
  const stageTemplates   = ref<any[]>([])
  const replyTone        = ref<string | null>(null)   // natural(null) / formal / lively
  const replyLength      = ref<string | null>(null)   // medium(null) / short / detailed
  const pmStagesExpanded  = ref(false)  // 项目编辑卡阶段区展开版面记忆
  const calendarDoneMode  = ref('done') // 'done' = 已完成项目显示到完成日；'deadline' = 显示到截止日
  const defaultView       = ref(localStorage.getItem('gugu-default-view') ?? 'projects')
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
      defaultView.value      = (data as any).defaultView ?? 'projects'
      localStorage.setItem('gugu-default-view', defaultView.value)
      loaded.value = true
    } catch {}
  }

  async function savePmStagesExpanded(v: boolean) {
    pmStagesExpanded.value = v
    try { await preferencesApi.update({ pmStagesExpanded: v }) } catch {}
  }

  async function saveCalendarDoneMode(v: string) {
    calendarDoneMode.value = v
    try { await preferencesApi.update({ calendarDoneMode: v } as any) } catch {}
  }

  async function saveDefaultView(v: string) {
    defaultView.value = v
    localStorage.setItem('gugu-default-view', v)
    try { await preferencesApi.update({ defaultView: v } as any) } catch {}
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
    lastStages, stageTemplates, replyTone, replyLength, pmStagesExpanded, calendarDoneMode, defaultView,
    loaded, fetch, saveLastStages, saveTemplates, saveStyle, savePmStagesExpanded, saveCalendarDoneMode, saveDefaultView,
  }
})
