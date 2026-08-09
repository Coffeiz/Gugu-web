import type { CalendarItem, CalendarRenderItem } from './calendarTypes'

type CalendarRuleItem = CalendarItem | CalendarRenderItem

const TYPE_LABEL: Record<string, string> = {
  deadline: '截止日',
  meeting: '会议',
  review: '审核',
  milestone: '节点',
  project: '进行中',
}

export function canDrag(item: CalendarRuleItem) {
  return item.type === 'event' || item.type === 'project' || ('calendarType' in item && (item.calendarType === 'event' || item.calendarType === 'project'))
}

export function canResize(item: CalendarRuleItem) {
  return item.type === 'event' || item.type === 'project' || ('calendarType' in item && (item.calendarType === 'event' || item.calendarType === 'project'))
}

export function getDisplayColor(item: CalendarRuleItem) {
  return 'accent' in item ? item.accent : item.color ?? '#8a8fa8'
}

export function typeLabel(type: string | undefined) {
  return TYPE_LABEL[type ?? ''] ?? '活动'
}
