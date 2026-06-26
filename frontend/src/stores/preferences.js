import { defineStore } from 'pinia'
import { ref } from 'vue'
import { preferencesApi } from '@/services/api'

export const usePreferencesStore = defineStore('preferences', () => {
  const lastStages     = ref([])
  const stageTemplates = ref([])
  const replyTone      = ref(null)   // natural(null) / formal / lively
  const replyLength    = ref(null)   // medium(null) / short / detailed
  const loaded         = ref(false)

  async function fetch() {
    try {
      const data = await preferencesApi.get()
      lastStages.value     = data.lastStages     ?? []
      stageTemplates.value = data.stageTemplates ?? []
      replyTone.value      = data.replyTone      ?? null
      replyLength.value    = data.replyLength    ?? null
      loaded.value = true
    } catch {}
  }

  async function saveLastStages(stages) {
    lastStages.value = stages
    try { await preferencesApi.update({ lastStages: stages }) } catch {}
  }

  async function saveTemplates(templates) {
    stageTemplates.value = templates
    try { await preferencesApi.update({ stageTemplates: templates }) } catch {}
  }

  async function saveStyle({ tone, length }) {
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
    lastStages, stageTemplates, replyTone, replyLength,
    loaded, fetch, saveLastStages, saveTemplates, saveStyle,
  }
})
