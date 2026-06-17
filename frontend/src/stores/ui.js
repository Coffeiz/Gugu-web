import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useUiStore = defineStore('ui', () => {
  const notifCount = ref(0)
  const openNewProject = ref(false)
  const sidebarCollapsed = ref(false)

  return { notifCount, openNewProject, sidebarCollapsed }
})
