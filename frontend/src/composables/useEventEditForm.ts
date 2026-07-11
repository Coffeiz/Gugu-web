/**
 * 日历活动的编辑态业务逻辑（时间输入格式化/全天切换/提醒 CRUD/保存删除），从
 * Calendar/index.vue 抽出来，好让笔记页的活动引用卡片也能弹同一套编辑表单——
 * 两处唯一的区别是外壳（Calendar 是跟随点击位置的浮层，笔记页是居中弹窗），
 * 表单字段和提醒逻辑本身完全一样，不用各写一份。
 */
import { ref, computed } from 'vue'
import { eventsApi, scheduledTasksApi } from '@/services/api'
import { useAuthStore } from '@/stores/auth'
import { useLiveStore } from '@/stores/live'

export interface EditingEvent {
  _uid?: string
  id: string | number
  name: string
  date: string
  time: string
  endTime: string
  description: string
  allDay: boolean
  version?: number
}

export interface Reminder { id?: number | null; leadMin: number }

export const LEAD_OPTIONS = [
  { label: '活动开始时',  min: 0 },
  { label: '提前 5 分钟', min: 5 },
  { label: '提前 15 分钟', min: 15 },
  { label: '提前 30 分钟', min: 30 },
  { label: '提前 1 小时', min: 60 },
  { label: '提前 2 小时', min: 120 },
  { label: '提前 1 天',   min: 1440 },
  { label: '提前 2 天',   min: 2880 },
]
export const CHAN_LABEL: Record<string, string> = { web: 'web', feishu: '飞书', qq: 'QQ', wechat: '微信' }

// 边打边格式化：取数字（最多4位），第2位后自动插冒号。1200 → 12:00、120 → 12:0
export function onTimeInput(e: Event, obj: { time: string; endTime: string }, key: 'time' | 'endTime') {
  const target = e.target as HTMLInputElement
  const d = target.value.replace(/\D/g, '').slice(0, 4)
  const out = d.length > 2 ? d.slice(0, 2) + ':' + d.slice(2) : d
  obj[key] = out
  target.value = out
}
// 时间直接输入：失焦时规整成 HH:MM（容忍「2330」「9:5」「23：00」等）；空/非法 → 空串
export function normTime(v: string | null | undefined) {
  if (!v) return ''
  let s = String(v).replace(/[：]/g, ':').replace(/[^\d:]/g, '')
  if (/^\d{3,4}$/.test(s)) s = s.slice(0, -2) + ':' + s.slice(-2)   // 2330 → 23:30
  const m = s.match(/^(\d{1,2}):?(\d{0,2})$/)
  if (!m) return ''
  const h = Math.min(23, parseInt(m[1] || '0', 10))
  const mm = Math.min(59, parseInt(m[2] || '0', 10))
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}
// 结束时间早于开始时间 → 视为次日（跨午夜）。HH:MM 已零填充，直接字符串比较即可
export function isNextDay(start: string | null | undefined, end: string | null | undefined) {
  return !!start && !!end && end < start
}
// 默认时间段：下一个整点 → 再过一小时。如现在 22:50 → 23:00–00:00（次日）
export function defaultTimeRange() {
  const now = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const sh = (now.getHours() + 1) % 24
  return { time: `${p(sh)}:00`, endTime: `${p((sh + 1) % 24)}:00` }
}
// 取消勾选「全天」时，若时间还是空的，补一个默认时间段
export function onToggleAllDay(obj: { allDay: boolean; time: string; endTime: string }) {
  if (!obj.allDay && !obj.time) Object.assign(obj, defaultTimeRange())
}

function _pad2(n: number) { return String(n).padStart(2, '0') }
function _reminderAtIso(date: string, time: string | undefined, leadMin: number) {
  const [h, mm] = (time || '09:00').split(':').map(Number)
  const d = new Date(`${date}T00:00:00`)
  d.setHours(h, mm - leadMin, 0, 0)   // 负分钟/跨天由 Date 自动回退
  return `${d.getFullYear()}-${_pad2(d.getMonth() + 1)}-${_pad2(d.getDate())}T${_pad2(d.getHours())}:${_pad2(d.getMinutes())}`
}

/** 每次调用都是一份独立状态——Calendar 的新建/编辑弹窗共用一份实例（同一时刻只开一个），
 *  全局的活动卡片弹窗另开一份，互不干扰。 */
export function useEventEditForm() {
  const authStore = useAuthStore()
  const liveStore = useLiveStore()
  const imChannels = computed(() => authStore.user?.imChannels ?? [])   // 用户已绑的 IM 平台

  const reminders          = ref<Reminder[]>([])       // [{ id?, leadMin }]，可多个
  const reminderChannels   = ref<string[]>(['web'])    // 渠道（web + 已绑 IM），该活动的提醒共用
  const removedReminderIds = ref<number[]>([])         // 编辑里删掉的已存在提醒 id，保存时真删

  function resetReminder() {
    reminders.value = []
    reminderChannels.value = ['web']
    removedReminderIds.value = []
  }
  function leadLabelOf(min: number) { return LEAD_OPTIONS.find(o => o.min === min)?.label || `提前 ${min} 分钟` }
  function toggleReminderChannel(ch: string) {
    const set = new Set(reminderChannels.value)
    set.has(ch) ? set.delete(ch) : set.add(ch)
    if (set.size === 0) set.add(ch)   // 至少留一个
    reminderChannels.value = [...set]
  }
  function addReminder() {
    // 点一下就建一条提醒（默认提前 30 分钟），之后用它自己的下拉改时间
    reminders.value.push({ leadMin: 30 })
  }
  function removeReminderAt(i: number) {
    const r = reminders.value[i]
    if (r?.id) removedReminderIds.value.push(r.id)
    reminders.value.splice(i, 1)
  }

  async function loadReminders(ev: { id: string | number; date?: string; time?: string }) {
    resetReminder()
    if (typeof ev.id !== 'number') return   // 临时事件（还没存）：保持 reset 态
    try {
      const tasks = (await scheduledTasksApi.listForEvent(ev.id))?.tasks || []
      if (!tasks.length) return
      reminderChannels.value = (tasks[0].channels && tasks[0].channels.length) ? tasks[0].channels : ['web']
      reminders.value = tasks.map((t: any) => {
        let leadMin = 0
        if ((t.cron || '').startsWith('@once:')) {
          const raw = Math.round((+new Date(`${ev.date}T${ev.time || '09:00'}`) - +new Date(t.cron.slice(6))) / 60000)
          leadMin = LEAD_OPTIONS.reduce((b, o) => Math.abs(o.min - raw) < Math.abs(b - raw) ? o.min : b, 0)
        }
        return { id: t.id, leadMin }
      })
    } catch { /* 保持 reset 态 */ }
  }

  // 保存活动后调用：对账该活动的提醒——删掉移除的、改已存在的渠道/时刻、建新增的
  async function applyReminders(eventId: number, name: string, date: string, time: string | undefined) {
    try {
      for (const id of removedReminderIds.value) await scheduledTasksApi.delete(id)
      removedReminderIds.value = []
      for (const r of reminders.value) {
        const cron = `@once:${_reminderAtIso(date, time, r.leadMin)}`
        const data = { name: `${name} 提醒`, payload: `提醒：${name}（${date}${time ? ' ' + time : ''}）`, cron, channels: reminderChannels.value }
        if (r.id) await scheduledTasksApi.update(r.id, data)
        else { const t = await scheduledTasksApi.create({ ...data, event_id: eventId }); r.id = t?.id ?? null }
      }
      liveStore.bump('scheduled_tasks')
    } catch { /* 提醒失败不挡活动保存 */ }
  }

  // 测试提醒渠道：往当前选的渠道发一条测试消息（不建任务，新建/编辑活动都能测）
  async function testReminderChannels(name: string) {
    return scheduledTasksApi.testNotify({ channels: reminderChannels.value, name: name || '活动提醒' })
  }

  /** 保存编辑中的活动：更新活动本身 + 对账提醒 + 广播日历有变（Calendar 页面自己的
   *  watch(liveStore.rev.calendar) 会据此刷新，不用这里手动去碰它的本地数组）。 */
  async function saveEvent(ev: EditingEvent) {
    if (ev.allDay) { ev.time = ''; ev.endTime = '' }
    const updated = await eventsApi.update(ev.id as unknown as number, {
      title: ev.name, date: ev.date, time: ev.time || null, endTime: ev.endTime || null,
      description: ev.description || undefined, version: ev.version,
    })
    await applyReminders(ev.id as unknown as number, ev.name, ev.date, ev.time)
    liveStore.bump('calendar')
    return updated
  }

  async function deleteEvent(id: string | number) {
    await eventsApi.delete(id as unknown as number)
    liveStore.bump('calendar')
  }

  return {
    imChannels, reminders, reminderChannels, removedReminderIds,
    resetReminder, leadLabelOf, toggleReminderChannel, addReminder, removeReminderAt,
    loadReminders, applyReminders, testReminderChannels,
    saveEvent, deleteEvent,
  }
}
