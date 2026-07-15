import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { playGuguSfx } from '@/services/sfx'

// 导航栏通知中心的持久条目（time 在前端归一成 Date）
interface NotifItem {
  id: number | null
  title?: string
  content?: string
  meta?: string
  color?: string
  unread: boolean
  time: Date
}
// SSE / 后端下发的原始通知载荷（字段多为可选，前端按需取用）
interface NotifInput {
  id?: number | null
  title?: string
  content?: string
  color?: string
  gugu?: boolean
  persist?: boolean
  bubble?: boolean
  time?: string | number | Date
  [k: string]: unknown
}
// 气泡（toast）信号
interface LiveNotif {
  seq: number
  id?: number | null
  title?: string
  content?: string
  gugu?: boolean
}

export const useUiStore = defineStore('ui', () => {
  const openNewProject = ref(false)
  const newProjectInitStatus = ref(null)
  const sidebarCollapsed = ref(false)
  const newProjectRange = ref<{ start: string; end: string } | null>(null)
  const calendarActiveRange = ref<{ start: string; end: string } | null>(null)
  const openProfile = ref(false)
  const pendingChatSession   = ref<unknown>(null)
  const pendingFileTarget    = ref<{ kind: string; id: number } | null>(null)
  const pendingChatMessageId = ref<number | null>(null)   // 对话搜索命中消息时，跳转后滚到该消息
  const pendingCalendarEvent = ref<{ id: number; date?: string } | null>(null)   // { id, date } 日程搜索跳转
  const pendingNoteId = ref<number | null>(null)   // 思维笔记搜索跳转后打开对应便签的编辑态
  const pendingCalendarDate  = ref<string | null>(null)   // 仪表盘小日历点某天 → 跳日历定位到该日（不高亮具体活动）
  const pendingProjectHighlight = ref<number | null>(null)   // 项目搜索跳转后高亮项目卡（不打开编辑弹窗）
  const pendingProjectHighlightMs = ref<number | null>(null) // 高亮时长(ms)：缺省 1800；新手引导用 5000（设 id 前先设它）
  const pendingProjectHighlightBreath = ref(false) // true=用「呼吸」动画（新手引导），缺省搜索 flash

  // 通知气泡锚点：距视口底部的 px。GuguChat 按小窗/播放器是否展开实时更新，
  // 让通知气泡始终浮在「聊天窗/音乐播放器」上方而不重叠。
  const chatNotifyAnchor = ref(90)
  // 通知气泡开合的缩放原点：直接浮在球上方时以咕咕球圆心缩放；被小窗/播放器顶高时从自身中心缩放
  // （与音乐播放器一致）。由 GuguChat 实时计算写入。
  const chatNotifyOrigin = ref('calc(100% - 25px) calc(100% + 37px)')

  // ── 通知 ────────────────────────────────────────────────
  // 导航栏通知中心：持久态（后端拉 + 实时追加），未读/已读落库，关浏览器重开还在。
  const notifications = ref<NotifItem[]>([])
  const notifCount = computed(() => notifications.value.filter(n => n.unread).length)
  // 气泡（toast）专用信号：置位即弹。实时到达 + 上线补弹最近一条都走它。
  const liveNotification = ref<LiveNotif | null>(null)
  let _liveSeq = 0
  const _BUBBLE_SEEN_KEY = 'gugu_last_bubble_id'   // 本设备已弹过的最大气泡 id（"只弹一次"）
  function _markBubbleSeen(id: number | null | undefined) {
    if (id != null) { try { localStorage.setItem(_BUBBLE_SEEN_KEY, String(id)) } catch {} }
  }

  // 登录后拉一次（含离线漏掉的）；DefaultLayout onMounted 调
  async function fetchNotifications() {
    try {
      const { notificationsApi } = await import('@/services/api')
      const list = await notificationsApi.list() as NotifInput[]
      notifications.value = list.map((n): NotifItem => ({
        id: n.id ?? null, title: n.title, content: n.content, color: n.color,
        unread: n.unread !== false, time: n.time ? new Date(n.time) : new Date(),
      }))
    } catch { /* 后端未就绪等：静默 */ }
  }

  // 实时 SSE 到达：按发布方选择的渠道分流——
  // persist=true 进持久列表（导航栏，落库可追踪）；bubble=true 弹气泡（toast，转瞬）。两者独立。
  // 缺省都为 true（兼容旧 payload）。
  function pushNotification(n: NotifInput) {
    const persist = n.persist !== false
    const bubble  = n.bubble  !== false
    if (persist) {
      const item: NotifItem = {
        id: n.id ?? null, title: n.title, content: n.content,
        color: n.color || '#7b7fb2', unread: true, time: new Date(),
      }
      if (item.id == null || !notifications.value.some(x => x.id === item.id)) {
        notifications.value.unshift(item)
      }
    }
    if (bubble) {
      // gugu=true：用咕咕聊天文字的大小/颜色（新手引导气泡），见 NotificationBubble .nb-gugu
      liveNotification.value = { seq: ++_liveSeq, id: n.id ?? null, title: n.title, content: n.content, gugu: n.gugu }
      playGuguSfx(n.gugu ? 'message' : 'notification')
      _markBubbleSeen(n.id)   // 实时弹过的，下次上线别再补弹
    }
  }

  // 上线补弹：拉最近一条有效气泡，比本设备记录新才弹一次（过期的后端已过滤）
  async function checkLoginBubble() {
    try {
      const { notificationsApi } = await import('@/services/api')
      const { bubble } = await notificationsApi.latestBubble()
      if (!bubble || bubble.id == null) return
      const last = Number(localStorage.getItem(_BUBBLE_SEEN_KEY) || 0)
      if (bubble.id > last) {
        liveNotification.value = { seq: ++_liveSeq, title: bubble.title, content: bubble.content }
        playGuguSfx('notification')
        _markBubbleSeen(bubble.id)
      }
    } catch { /* 静默 */ }
  }

  async function _persistRead(ids: number[] | null) {
    try {
      const { notificationsApi } = await import('@/services/api')
      await notificationsApi.markRead(ids)
    } catch { /* 落库失败不影响本地态 */ }
  }
  function markAllRead() {
    const ids = notifications.value.filter(n => n.unread && n.id != null).map(n => n.id)
    notifications.value.forEach(n => { n.unread = false })
    _persistRead(null)   // 全部已读
  }
  function markRead(id: number) {
    const n = notifications.value.find(x => x.id === id)
    if (n) n.unread = false
    if (id != null) _persistRead([id])
  }

  return {
    notifCount, notifications, liveNotification, fetchNotifications, checkLoginBubble,
    pushNotification, markAllRead, markRead,
    openNewProject, newProjectInitStatus, openProfile, sidebarCollapsed, newProjectRange,
    calendarActiveRange, pendingChatSession, pendingFileTarget, chatNotifyAnchor, chatNotifyOrigin,
    pendingChatMessageId, pendingCalendarEvent, pendingCalendarDate, pendingProjectHighlight, pendingProjectHighlightMs,
    pendingProjectHighlightBreath, pendingNoteId,
  }
})
