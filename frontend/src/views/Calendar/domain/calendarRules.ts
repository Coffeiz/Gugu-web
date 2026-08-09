import type { CalendarItem } from './calendarTypes'

const TYPE_LABEL: Record<string, string> = {
  deadline: '截止日',
  meeting: '会议',
  review: '审核',
  milestone: '节点',
  project: '进行中',
}

export function canDrag(item: CalendarItem) {
  return item.type === 'event' || item.type === 'project'
}

export function canResize(item: CalendarItem) {
  return item.type === 'event' || item.type === 'project'
}

export function getDisplayColor(item: CalendarItem) {
  return item.color ?? '#8a8fa8'
}

export function typeLabel(type: string | undefined) {
  return TYPE_LABEL[type ?? ''] ?? '活动'
}
