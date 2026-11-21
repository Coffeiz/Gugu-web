export interface CalendarDateRange { start: string; end: string }

export type CalendarContext =
  | { type: 'month-cell'; date: string; range: CalendarDateRange | null }
  | { type: 'week-column'; date: string; time: string; endTime: string }
  | { type: 'allday'; date: string; range: CalendarDateRange | null }
