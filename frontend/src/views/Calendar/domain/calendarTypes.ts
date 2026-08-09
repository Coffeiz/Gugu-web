/**
 * Calendar 领域数据。事件和项目使用 type 判别，规则不通过 draggable/resizable
 * 这类派生字段回写到实体上。
 */
export interface CalendarItemBase {
  id: string | number
  title: string
  start: string
  end?: string
  allDay: boolean
  color?: string
}

export interface EventCalendarItem extends CalendarItemBase {
  type: 'event'
  time?: string
  endTime?: string
  description?: string
  eventType?: string
  version?: number
  client?: string | null
}

export interface ProjectCalendarItem extends CalendarItemBase {
  type: 'project'
  client?: string | null
  status: string
  currentStage?: string | null
  priority?: string | null
  createdAt?: string
  progress?: number
}

export type CalendarItem = EventCalendarItem | ProjectCalendarItem

/**
 * 迁移期间供旧模板和交互状态使用的视图形状。
 * 它不是领域模型，布局回填字段只允许停留在这一层。
 */
export interface CalendarRenderItem {
  id: string | number
  _uid?: string
  name: string
  date?: string
  time?: string
  endTime?: string
  client?: string | null
  type?: string
  accent: string
  isUserEvent?: boolean
  isProject?: boolean
  description?: string
  version?: number
  status?: string
  startDate?: string | null
  endDate?: string | null
  currentStage?: string | null
  priority?: string | null
  createdAt?: string
  progress?: number
  colStart?: number
  colEnd?: number
  startsHere?: boolean
  endsHere?: boolean
  segStartIso?: string
  segEndIso?: string
  row?: number
  daysLeft?: number
  daysLabel?: string
}
