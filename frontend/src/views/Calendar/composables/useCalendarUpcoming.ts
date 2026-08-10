import { ref } from 'vue'
import type { CalendarRenderItem } from '../domain/calendarTypes'

type UpcomingItem = CalendarRenderItem & { daysLeft?: number; daysLabel?: string }

function toIso(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function priority(item: CalendarRenderItem) {
  return ({ high: 3, medium: 2, low: 1 } as Record<string, number>)[item.priority ?? ''] ?? 0
}

export function buildUpcomingList(projects: CalendarRenderItem[], events: CalendarRenderItem[], now = new Date()): UpcomingItem[] {
  const today = toIso(now)
  const cutoff = toIso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 15))
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const label = (iso: string | null | undefined) => {
    const days = Math.round((+new Date((iso ?? '') + 'T00:00:00') - +midnight) / 86400000)
    return { daysLeft: days, daysLabel: days === 0 ? '今天' : days === 1 ? '明天' : days + '天后' }
  }

  const upcomingProjects = projects
    .filter(item => (item.endDate ?? '') >= today && (item.endDate ?? '') <= cutoff)
    .sort((a, b) => {
      const doneDiff = (a.status === 'done' ? 1 : 0) - (b.status === 'done' ? 1 : 0)
      return doneDiff || priority(b) - priority(a)
        || (a.startDate ?? '').localeCompare(b.startDate ?? '')
        || (a.endDate ?? '').localeCompare(b.endDate ?? '')
        || (a.createdAt ?? '').localeCompare(b.createdAt ?? '')
    })
    .slice(0, 4)
    .map(item => ({ ...item, date: item.endDate ?? undefined, ...label(item.endDate) }))

  const seen = new Set<string | number>()
  const upcomingEvents = events
    .filter(item => {
      if (seen.has(item.id)) return false
      seen.add(item.id)
      return (item.date ?? '') >= today && (item.date ?? '') <= cutoff
    })
    .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))
    .slice(0, 4)
    .map(item => ({ ...item, ...label(item.date) }))

  return [...upcomingProjects, ...upcomingEvents]
}

export function useCalendarUpcoming() {
  const upcomingList = ref<UpcomingItem[]>([])
  function refresh(projects: CalendarRenderItem[], events: CalendarRenderItem[], now?: Date) {
    upcomingList.value = buildUpcomingList(projects, events, now)
  }
  return { upcomingList, refresh }
}
