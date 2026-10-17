import type { CalendarRenderItem } from '../domain/calendarTypes'

/** 保留“更多”弹窗中的项目快照，同时用当前日历数据刷新活动项并过滤已删除活动。 */
export function resolveCalendarMoreItems(
  items: CalendarRenderItem[],
  currentEvents: CalendarRenderItem[],
): CalendarRenderItem[] {
  const eventsById = new Map(
    currentEvents
      .filter(item => item.calendarType === 'event')
      .map(item => [String(item.id), item]),
  )

  return items.flatMap(item => {
    if (item.calendarType !== 'event') return [item]
    const current = eventsById.get(String(item.id))
    return current ? [current] : []
  })
}
