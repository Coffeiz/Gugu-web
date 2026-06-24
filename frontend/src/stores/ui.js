import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useUiStore = defineStore('ui', () => {
  const notifCount = ref(0)
  const openNewProject = ref(false)
  const sidebarCollapsed = ref(false)
  const newProjectRange = ref(null)        // { start: iso, end: iso } | null
  const calendarActiveRange = ref(null)   // 日历当前多选范围，供顶栏按钮使用

  const openProfile = ref(false)
  const pendingChatSession = ref(null)   // 顶栏搜索点「对话」时设为 session_id，GuguChat 监听后打开并切换
  const pendingFileTarget  = ref(null)   // 顶栏搜索点「文件/文件夹」时设为 {kind,id}，文件库监听后定位到对应目录

  return { notifCount, openNewProject, openProfile, sidebarCollapsed, newProjectRange, calendarActiveRange, pendingChatSession, pendingFileTarget }
})
