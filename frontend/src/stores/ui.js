import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useUiStore = defineStore('ui', () => {
  const notifCount = ref(0)
  const openNewProject = ref(false)
  const sidebarCollapsed = ref(false)
  const newProjectRange = ref(null)   // { start: iso, end: iso } | null

  return { notifCount, openNewProject, sidebarCollapsed, newProjectRange }
})
