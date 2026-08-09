import type { components } from '@/types/api'
import type { CalendarItem, EventCalendarItem, ProjectCalendarItem, CalendarRenderItem } from './calendarTypes'

type EventResponse = components['schemas']['EventResponse']

const TYPE_ACCENT: Record<string, string> = {
  meeting: '#7b7fb2',
  review: '#7ab8c8',
  milestone: '#c4afc8',
  deadline: '#b07858',
  event: '#8a8fa8',
}

export function normalizeEvent(event: EventResponse): EventCalendarItem {
  return {
    id: event.id,
    type: 'event',
    title: event.title,
    start: event.date,
    end: event.endTime || undefined,
    allDay: !event.time,
    color: TYPE_ACCENT[event.type] ?? TYPE_ACCENT.event,
    time: event.time ?? '',
    endTime: event.endTime ?? '',
    description: event.description ?? '',
    eventType: event.type,
    client: event.client ?? '',
    version: event.version ?? 1,
  }
}

export interface ProjectTimelineSource {
  id: string | number
  name: string
  client?: string | null
  startDate?: string | null
  endDate?: string | null
  accent: string
  status: string
  currentStage?: string | null
  priority?: string | null
  createdAt?: string
  progress?: number
}

export function normalizeProjectTimeline(project: ProjectTimelineSource): ProjectCalendarItem {
  return {
    id: project.id,
    type: 'project',
    title: project.name,
    start: project.startDate ?? '',
    end: project.endDate ?? undefined,
    allDay: true,
    color: project.accent,
    client: project.client,
    status: project.status,
    currentStage: project.currentStage,
    priority: project.priority,
    createdAt: project.createdAt,
    progress: project.progress,
  }
}

export function toRenderItem(item: CalendarItem, options: { uid?: string; legacyType?: string } = {}): CalendarRenderItem {
  if (item.type === 'event') {
    return {
      _uid: options.uid ?? `e${item.id}`,
      id: item.id,
      date: item.start,
      time: item.time ?? '',
      endTime: item.endTime ?? item.end ?? '',
      name: item.title,
      client: item.client ?? '',
      type: item.eventType,
      accent: item.color ?? TYPE_ACCENT.event,
      isUserEvent: true,
      description: item.description ?? '',
      version: item.version ?? 1,
    }
  }
  return {
    id: item.id,
    name: item.title,
    client: item.client,
    startDate: item.start || null,
    endDate: item.end || null,
    accent: item.color ?? TYPE_ACCENT.event,
    type: options.legacyType ?? 'project',
    isProject: true,
    status: item.status,
    currentStage: item.currentStage,
    priority: item.priority,
    createdAt: item.createdAt ?? '',
    progress: item.progress,
  }
}

export { TYPE_ACCENT }
