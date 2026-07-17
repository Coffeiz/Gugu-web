import { computed, type Ref } from 'vue'
import type { Project } from '@/types/project'
import type { DoneGroup, DoneMonthGroup, DoneRecentGroup, DoneUndatedGroup, DoneYearGroup } from './doneTypes'

function dateOf(project: Project): Date | null {
  const source = project.startDate || project.deadline || project.doneAt || null
  if (!source) return null
  return new Date(source.length === 10 ? `${source}T00:00:00` : source)
}

export function useDoneGroups(projects: Ref<Project[]>, openYears: Ref<Set<string>>, openMonths: Ref<Set<string>>) {
  const recent = computed<DoneRecentGroup>(() => ({
    key: 'recent', type: 'recent', label: '最近完成',
    items: [...projects.value].sort((a, b) =>
      (b.doneAt || b.deadline || b.startDate || '').localeCompare(a.doneAt || a.deadline || a.startDate || '')
    ).slice(0, 3),
  }))
  const recentIds = computed(() => new Set(recent.value.items.map(project => project.id)))
  const undated = computed<DoneUndatedGroup>(() => ({
    key: 'undated', type: 'undated', label: '未设置日期',
    items: projects.value.filter(project => !dateOf(project) && !recentIds.value.has(project.id)),
  }))
  const groups = computed<DoneGroup[]>(() => {
    const years = new Map<string, Map<string, Project[]>>()
    for (const project of projects.value) {
      if (recentIds.value.has(project.id)) continue
      const date = dateOf(project)
      if (!date) continue
      const year = String(date.getFullYear())
      const month = `${String(date.getMonth() + 1).padStart(2, '0')}月`
      if (!years.has(year)) years.set(year, new Map())
      const months = years.get(year)!
      if (!months.has(month)) months.set(month, [])
      months.get(month)!.push(project)
    }
    const result: DoneGroup[] = []
    if (recent.value.items.length) result.push(recent.value)
    for (const [year, months] of [...years.entries()].sort(([a], [b]) => b.localeCompare(a))) {
      const children: DoneMonthGroup[] = [...months.entries()]
        .sort(([a], [b]) => b.localeCompare(a))
        .map(([month, items]) => ({
          key: `month-${year}-${month}`, type: 'month', label: month, year, month, items,
          open: openMonths.value.has(`${year}${month}`),
        }))
      result.push({ key: `year-${year}`, type: 'year', label: year, year, children, open: openYears.value.has(year) })
    }
    if (undated.value.items.length) result.push(undated.value)
    return result
  })
  const toggleGroup = (key: string) => {
    const target = key.startsWith('year-') ? openYears : openMonths
    const value = new Set(target.value)
    const actual = key.startsWith('year-') ? key.slice(5) : key
    value.has(actual) ? value.delete(actual) : value.add(actual)
    target.value = value
  }
  return { groups, recent, recentIds, undated, toggleGroup, isGroupOpen: (key: string) => openYears.value.has(key) || openMonths.value.has(key) }
}
