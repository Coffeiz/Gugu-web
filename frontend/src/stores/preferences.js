import { defineStore } from 'pinia'
import { ref } from 'vue'
import { preferencesApi } from '@/services/api'

export const usePreferencesStore = defineStore('preferences', () => {
  const lastStages     = ref([])
  const stageTemplates = ref([])
  const loaded         = ref(false)

  async function fetch() {
    try {
      const data = await preferencesApi.get()
      lastStages.value     = data.lastStages     ?? []
      stageTemplates.value = data.stageTemplates ?? []
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

  return { lastStages, stageTemplates, loaded, fetch, saveLastStages, saveTemplates }
})
