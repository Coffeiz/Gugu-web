import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export const useUiStore = defineStore('ui', () => {
  const openNewProject = ref(false)
  const newProjectInitStatus = ref(null)
  const sidebarCollapsed = ref(false)
  const newProjectRange = ref(null)
  const calendarActiveRange = ref(null)
  const openProfile = ref(false)
  const pendingChatSession   = ref(null)
  const pendingFileTarget    = ref(null)
  const pendingChatMessageId = ref(null)   // 对话搜索命中消息时，跳转后滚到该消息
  const pendingCalendarEvent = ref(null)   // { id, date } 日程搜索跳转

  // 通知气泡锚点：距视口底部的 px。GuguChat 按小窗/播放器是否展开实时更新，
  // 让通知气泡始终浮在「聊天窗/音乐播放器」上方而不重叠。
  const chatNotifyAnchor = ref(90)
  // 通知气泡开合的缩放原点：直接浮在球上方时以咕咕球圆心缩放；被小窗/播放器顶高时从自身中心缩放
  // （与音乐播放器一致）。由 GuguChat 实时计算写入。
  const chatNotifyOrigin = ref('calc(100% - 25px) calc(100% + 37px)')

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
    openNewProject, newProjectInitStatus, openProfile, sidebarCollapsed, newProjectRange,
    calendarActiveRange, pendingChatSession, pendingFileTarget, chatNotifyAnchor, chatNotifyOrigin,
    pendingChatMessageId, pendingCalendarEvent,
  }
})
