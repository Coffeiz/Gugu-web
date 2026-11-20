import { computed, type ComputedRef } from 'vue'
import { useProjectStore } from '@/stores/projects'
import { extractProjectAccent } from '@/utils/projectColors'
import { projectProgress } from '@/utils/projectProgress'
import { capBg, darkenHex } from '@/utils/calendarColors'
import { normalizeProjectTimeline, toRenderItem } from '@/views/Calendar/domain/calendarNormalizer'
import type { CalendarMonthDay, CalendarRenderItem, CalendarWeekDay } from '@/views/Calendar/domain/calendarTypes'
import { capWeekBars, dayLayout as calculateDayLayout, maxSlots, weekBars } from '@/views/Calendar/utils/calendarLayout'

export const layout = { headerHeight: 32, cellTop: 31, bottomPadding: 8, barHeight: 20, hourHeight: 36 }

export function useDesktopCalendarLayout(
  events: ComputedRef<CalendarRenderItem[]>,
  monthWeeks: ComputedRef<CalendarMonthDay[][]>,
  weekDays: ComputedRef<CalendarWeekDay[]>,
  weekHeights: Record<number, number>,
  monthDragPreview: ComputedRef<{ item: CalendarRenderItem; range: { start: string; end: string } } | null>,
) {
  const projectStore = useProjectStore()
  const projects = computed(() => projectStore.projects
    .filter(project => project.startDate && project.deadline)
    .map(project => toRenderItem(normalizeProjectTimeline({
      id: `p${project.id}`,
      name: project.name,
      startDate: project.startDate,
      endDate: project.deadline,
      accent: extractProjectAccent(project.color),
      status: project.status,
      currentStage: project.stages?.find(stage => stage.key === project.currentStage)?.label,
      priority: project.priority,
      createdAt: project.createdAt,
      progress: projectProgress(project),
    }))))
  const monthProjects = computed(() => {
    const preview = monthDragPreview.value
    if (preview?.item.calendarType !== 'project') return projects.value
    return projects.value.map(project => project.id === preview.item.id
      ? { ...project, startDate: preview.range.start, endDate: preview.range.end }
      : project)
  })
  const monthEvents = computed(() => {
    const preview = monthDragPreview.value
    if (preview?.item.calendarType !== 'event') return events.value
    return events.value.map(event => event.id === preview.item.id ? { ...event, date: preview.range.start } : event)
  })
  const monthBars = computed(() => monthWeeks.value.map(week => weekBars(monthProjects.value, week)))
  const weekAllDay = computed(() => weekBars(projects.value, weekDays.value))
  const weekAllDayShown = computed(() => capWeekBars(weekAllDay.value, 5))
  const wvShownRows = computed(() => Math.max(0, ...weekAllDayShown.value.map(bar => (bar.row ?? 0) + 1)))
  const wvAllDayH = computed(() => Math.max(52, ...weekDays.value.map((day, index) => (
    (wvShownRows.value + allDayItemsFor(day.iso).length + Number(weekMoreFor(index).length > 0)) * layout.barHeight + 6
  ))))

  function singleDayProjects(iso: string, items = projects.value) {
    return items.filter(project => project.startDate === iso && project.endDate === iso)
  }
  function weekBarsCapped(_week: CalendarMonthDay[], index: number) {
    return { bars: capWeekBars(monthBars.value[index] ?? [], maxSlots(weekHeights[index] ?? 100, layout)) }
  }
  function dayLayout(iso: string, week: CalendarMonthDay[], index: number) {
    return calculateDayLayout(
      iso, weekBarsCapped(week, index).bars, monthBars.value[index] ?? [],
      singleDayProjects(iso, monthProjects.value), monthEvents.value, maxSlots(weekHeights[index] ?? 100, layout), layout,
    )
  }
  function allDayItemsFor(iso: string) {
    return [...singleDayProjects(iso), ...events.value.filter(event => event.date === iso && !event.time)]
  }
  function weekMoreFor(index: number) {
    return weekAllDay.value.filter(bar => (bar.row ?? 0) >= 5 && (bar.colStart ?? 0) <= index && (bar.colEnd ?? 0) >= index)
  }
  function pbarStyle(bar: CalendarRenderItem) {
    const left = (bar.colStart ?? 0) / 7 * 100
    const right = (6 - (bar.colEnd ?? 0)) / 7 * 100
    return {
      left: bar.startsHere ? `calc(${left}% + 6px)` : `${left}%`,
      right: bar.endsHere ? `calc(${right}% + 6px)` : `${right}%`,
      top: `${(bar.row ?? 0) * layout.barHeight}px`,
      background: capBg(bar.accent, bar.progress),
      borderColor: bar.accent + '70',
      color: darkenHex(bar.accent),
    }
  }

  return { projects, dayLayout, weekBarsCapped, weekAllDayShown, wvShownRows, wvAllDayH, allDayItemsFor, weekMoreFor, pbarStyle }
}
