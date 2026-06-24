import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export const useUiStore = defineStore('ui', () => {
  const openNewProject = ref(false)
  const sidebarCollapsed = ref(false)
  const newProjectRange = ref(null)
  const calendarActiveRange = ref(null)
  const openProfile = ref(false)
  const pendingChatSession = ref(null)
  const pendingFileTarget  = ref(null)

  // 通知中心
  let _nid = 0
  const notifications = ref([])
  const notifCount = computed(() => notifications.value.filter(n => n.unread).length)

  function pushNotification({ title, content, color = '#7b7fb2' }) {
    notifications.value.unshift({ id: ++_nid, title, content, color, unread: true, time: new Date() })
  }
  function markAllRead() {
    notifications.value.forEach(n => { n.unread = false })
  }

  return {
    notifCount, notifications, pushNotification, markAllRead,
    openNewProject, openProfile, sidebarCollapsed, newProjectRange,
    calendarActiveRange, pendingChatSession, pendingFileTarget,
  }
})
