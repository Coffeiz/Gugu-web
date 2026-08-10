import type { CalendarRenderItem } from '../domain/calendarTypes'

export interface CalendarWeekDay { iso: string }

export interface CalendarLayoutConstants {
  headerHeight: number
  cellTop: number
  bottomPadding: number
  barHeight: number
  hourHeight: number
}

export interface DayLayoutResult {
  paddingTop: number
  visibleChips: CalendarRenderItem[]
  moreCount: number
  moreItems: CalendarRenderItem[]
}

export interface TimedLayoutItem {
  ev: CalendarRenderItem
  top: number
  height: number
  leftPct: number
  widthPct: number
}

const PRIORITY: Record<string, number> = { high: 3, medium: 2, low: 1 }

function priority(item: CalendarRenderItem) { return PRIORITY[item.priority ?? ''] ?? 0 }

export function maxSlots(weekHeight: number, constants: CalendarLayoutConstants) {
  return Math.max(1, Math.floor((weekHeight - constants.headerHeight - constants.bottomPadding) / constants.barHeight))
}

export function weekBars(items: CalendarRenderItem[], week: CalendarWeekDay[]): CalendarRenderItem[] {
  const ws = week[0]?.iso ?? ''
  const we = week[6]?.iso ?? ''
  const bars = items
    .filter(item => (item.endDate ?? '') >= ws && (item.startDate ?? '') <= we && item.startDate !== item.endDate)
    .map(item => {
      const colStart = (item.startDate ?? '') <= ws ? 0 : week.findIndex(day => day.iso >= (item.startDate ?? ''))
      let colEnd = 6
      for (let i = 6; i >= 0; i--) {
        if ((week[i]?.iso ?? '') <= (item.endDate ?? '')) { colEnd = i; break }
      }
      const start = Math.max(0, colStart)
      const end = Math.min(6, colEnd)
      return {
        ...item,
        colStart: start,
        colEnd: end,
        startsHere: (item.startDate ?? '') >= ws && (item.startDate ?? '') <= we,
        endsHere: (item.endDate ?? '') >= ws && (item.endDate ?? '') <= we,
        segStartIso: week[start]?.iso,
        segEndIso: week[end]?.iso,
        row: 0,
      }
    })

  bars.sort((a, b) => {
    const doneDiff = (a.status === 'done' ? 1 : 0) - (b.status === 'done' ? 1 : 0)
    if (doneDiff) return doneDiff
    const priorityDiff = priority(b) - priority(a)
    if (priorityDiff) return priorityDiff
    if (a.startDate !== b.startDate) return (a.startDate ?? '').localeCompare(b.startDate ?? '')
    if (a.endDate !== b.endDate) return (a.endDate ?? '').localeCompare(b.endDate ?? '')
    return (a.createdAt ?? '').localeCompare(b.createdAt ?? '')
  })

  const rowEnds: number[] = []
  bars.forEach(bar => {
    let row = 0
    while (rowEnds[row] !== undefined && rowEnds[row] >= (bar.colStart ?? 0)) row++
    bar.row = row
    rowEnds[row] = bar.colEnd ?? 0
  })
  return bars
}

export function capWeekBars(all: CalendarRenderItem[], max: number) {
  return all.filter(item => (item.row ?? 0) < max)
}

export function dayLayout(
  iso: string,
  cappedBars: CalendarRenderItem[],
  allBars: CalendarRenderItem[],
  singleDayProjects: CalendarRenderItem[],
  extraEvents: CalendarRenderItem[],
  max: number,
  constants: CalendarLayoutConstants,
): DayLayoutResult {
  let maxBarRow = -1
  cappedBars.forEach(bar => {
    if ((bar.startDate ?? '') <= iso && (bar.endDate ?? '') >= iso) maxBarRow = Math.max(maxBarRow, bar.row ?? 0)
  })
  const nextRow = maxBarRow + 1
  const paddingTop = Math.max(0, nextRow * constants.barHeight + constants.headerHeight - constants.cellTop)
  const slots = Math.max(0, max - nextRow)

  const cappedIds = new Set(cappedBars.map(bar => bar.id))
  const hiddenProjects = allBars
    .filter(bar => (bar.startDate ?? '') <= iso && (bar.endDate ?? '') >= iso && !cappedIds.has(bar.id))
    .map(bar => ({ ...bar, calendarType: 'project' as const }))

  const allChips = [...singleDayProjects, ...extraEvents.filter(event => event.date === iso)]
  allChips.sort((a, b) => {
    const doneDiff = (a.status === 'done' ? 1 : 0) - (b.status === 'done' ? 1 : 0)
    if (doneDiff) return doneDiff
    const priorityDiff = priority(b) - priority(a)
    if (priorityDiff) return priorityDiff
    const aStart = a.startDate ?? a.date ?? ''
    const bStart = b.startDate ?? b.date ?? ''
    if (aStart !== bStart) return aStart.localeCompare(bStart)
    const aEnd = a.endDate ?? a.date ?? ''
    const bEnd = b.endDate ?? b.date ?? ''
    if (aEnd !== bEnd) return aEnd.localeCompare(bEnd)
    return (a.createdAt ?? '').localeCompare(b.createdAt ?? '')
  })

  const moreItems = hiddenProjects.length > 0 || allChips.length > slots
    ? [...hiddenProjects, ...allChips.slice(Math.max(0, slots - 1))]
    : []
  if (!moreItems.length) return { paddingTop, visibleChips: allChips, moreCount: 0, moreItems: [] }

  const visibleChips = allChips.slice(0, Math.max(0, slots - 1))
  return { paddingTop, visibleChips, moreCount: moreItems.length, moreItems }
}

function parseMinutes(time: string | undefined) {
  const [hours, minutes] = (time || '').split(':').map(Number)
  return (hours || 0) * 60 + (minutes || 0)
}

export function timedLayoutFor(events: CalendarRenderItem[], iso: string, hourHeight: number): TimedLayoutItem[] {
  const items = events
    .filter(event => event.date === iso && event.time)
    .map(event => {
      const start = parseMinutes(event.time)
      let end = event.endTime ? parseMinutes(event.endTime) : start + 60
      if (end <= start) end = 1440
      return { ev: event, s: start, e: Math.min(1440, end), col: 0, count: 1 }
    })
    .sort((a, b) => a.s - b.s || a.e - b.e)

  const result: typeof items = []
  let cluster: typeof items = []
  let clusterEnd = -1
  const flush = () => {
    const columnEnds: number[] = []
    cluster.forEach(item => {
      let col = 0
      while (col < columnEnds.length && columnEnds[col] > item.s) col++
      item.col = col
      columnEnds[col] = item.e
    })
    const count = Math.max(1, columnEnds.length)
    cluster.forEach(item => { item.count = count })
    result.push(...cluster)
    cluster = []
    clusterEnd = -1
  }

  items.forEach(item => {
    if (cluster.length && item.s >= clusterEnd) flush()
    cluster.push(item)
    clusterEnd = Math.max(clusterEnd, item.e)
  })
  flush()

  return result.map(item => ({
    ev: item.ev,
    top: item.s / 60 * hourHeight,
    height: Math.max(15, (item.e - item.s) / 60 * hourHeight - 2),
    leftPct: item.col / item.count * 100,
    widthPct: 100 / item.count,
  }))
}
