import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useUiStore = defineStore('ui', () => {
  const notifCount = ref(0)
  const openNewProject = ref(false)
  const sidebarCollapsed = ref(false)
  const newProjectRange = ref(null)        // { start: iso, end: iso } | null
  const calendarActiveRange = ref(null)   // 日历当前多选范围，供顶栏按钮使用

  return { notifCount, openNewProject, sidebarCollapsed, newProjectRange, calendarActiveRange }
})
