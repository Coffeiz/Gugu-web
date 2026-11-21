import type { Project } from '@/types/project'

export interface DoneRecentGroup {
  key: 'recent'
  type: 'recent'
  label: string
  items: Project[]
}

export interface DoneMonthGroup {
  key: string
  type: 'month'
  label: string
  year: string
  month: string
  items: Project[]
  open: boolean
}

export interface DoneUndatedGroup {
  key: 'undated'
  type: 'undated'
  label: string
  items: Project[]
}

export interface DoneYearGroup {
  key: string
  type: 'year'
  label: string
  year: string
  children: DoneMonthGroup[]
  open: boolean
}

export type DoneGroup = DoneRecentGroup | DoneMonthGroup | DoneUndatedGroup | DoneYearGroup
