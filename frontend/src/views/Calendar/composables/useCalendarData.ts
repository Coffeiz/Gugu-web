import { computed, ref, watch, type ComputedRef } from 'vue'
import { eventsApi } from '@/services/api'
import { calendarSignal } from '@/services/cache'
import { projectProgress } from '@/utils/projectProgress'
import { extractAccent } from '../utils/calendarColors'
import { normalizeEvent, normalizeProjectTimeline, toRenderItem } from '../domain/calendarNormalizer'
import type { CalendarRenderItem } from '../domain/calendarTypes'
import type { Project } from '@/types/project'
import type { components } from '@/types/api'

type CalendarEvent = CalendarRenderItem
type EventResponse = components['schemas']['EventResponse']

// 日历页会同时读取当前月、相邻月和“即将到来”月份。缓存放在 composable 模块作用域，
// 保留原页面在同一次前端会话中切换视图时的缓存行为，但不再让入口文件管理缓存细节。
const eventsCache: Record<string, CalendarEvent[]> = {}

interface CalendarDataOptions {
  cursor: ComputedRef<Date> | { value: Date }
  projects: () => readonly Project[]
  doneMode: () => string
}

function toIso(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function monthKey(date: Date) {
  return `${date.getFullYear()}-${date.getMonth() + 1}`
}

function normalizeCalendarEvent(event: EventResponse): CalendarEvent {
  return toRenderItem(normalizeEvent(event), {
    uid: (event as EventResponse & { _uid?: string })._uid ?? `e${event.id}`,
  })
}

export function useCalendarData({ cursor, projects, doneMode }: CalendarDataOptions) {
  const extraEvents = ref<CalendarEvent[]>([])
  const nextMonthEvents = ref<CalendarEvent[]>([])
  const spilloverEvents = ref<CalendarEvent[]>([])

  async function fetchMonth(date: Date) {
    const key = monthKey(date)
    if (eventsCache[key]) return eventsCache[key]
    try {
      const normalized = (await eventsApi.list(date.getFullYear(), date.getMonth() + 1)).map(normalizeCalendarEvent)
      eventsCache[key] = normalized
      return normalized
    } catch {
      return []
    }
  }

  async function fetchEvents() {
    const date = cursor.value
    const key = monthKey(date)
    if (eventsCache[key]) extraEvents.value = eventsCache[key]
    try {
      const normalized = (await eventsApi.list(date.getFullYear(), date.getMonth() + 1)).map(normalizeCalendarEvent)
      eventsCache[key] = normalized
      extraEvents.value = normalized
    } catch { /* 保留已有缓存，避免短暂网络错误清空当前视图 */ }
  }

  async function fetchNextMonthEvents() {
    const now = new Date()
    const date = new Date(now.getFullYear(), now.getMonth() + 1, 1)
    const key = monthKey(date)
    if (eventsCache[key]) {
      nextMonthEvents.value = eventsCache[key]
      return
    }
    nextMonthEvents.value = await fetchMonth(date)
  }

  async function fetchSpilloverEvents() {
    const date = cursor.value
    const previous = new Date(date.getFullYear(), date.getMonth() - 1, 1)
    const next = new Date(date.getFullYear(), date.getMonth() + 1, 1)
    const [previousEvents, nextEvents] = await Promise.all([fetchMonth(previous), fetchMonth(next)])
    spilloverEvents.value = [...previousEvents, ...nextEvents]
  }

  function clearCache() {
    for (const key in eventsCache) delete eventsCache[key]
  }

  function cacheMonth(date: Date, items: CalendarEvent[]) {
    eventsCache[monthKey(date)] = items
  }

  async function refreshFromSignal() {
    clearCache()
    await Promise.all([fetchEvents(), fetchSpilloverEvents()])
  }

  watch(calendarSignal, () => { void refreshFromSignal() })

  const visibleEvents = computed<CalendarEvent[]>(() => {
    const ids = new Set(extraEvents.value.map(event => event.id))
    return [...extraEvents.value, ...spilloverEvents.value.filter(event => !ids.has(event.id))]
  })

  const projectTimelines = computed<CalendarEvent[]>(() => {
    const showDoneDate = doneMode() === 'done'
    return projects()
      .filter(project => project.startDate && project.deadline)
      .map(project => {
        const startDate = showDoneDate && project.status === 'done' && project.doneAt && project.startDate && toIso(new Date(project.doneAt)) < project.startDate
          ? toIso(new Date(project.doneAt))
          : project.startDate
        const endDate = showDoneDate && project.status === 'done' && project.doneAt
          ? toIso(new Date(project.doneAt))
          : project.deadline
        return toRenderItem(normalizeProjectTimeline({
          id: `p${project.id}`,
          name: project.name,
          client: project.client,
          startDate,
          endDate,
          accent: extractAccent(project.color),
          status: project.status,
          currentStage: project.stages?.find(stage => stage.key === project.currentStage)?.label ?? null,
          priority: project.priority ?? null,
          createdAt: project.createdAt ?? '',
          progress: projectProgress(project),
        }), { legacyType: 'deadline' })
      })
  })

  return {
    extraEvents,
    nextMonthEvents,
    spilloverEvents,
    visibleEvents,
    projectTimelines,
    fetchEvents,
    fetchNextMonthEvents,
    fetchSpilloverEvents,
    refreshFromSignal,
    cacheMonth,
    normalizeCalendarEvent,
  }
}
