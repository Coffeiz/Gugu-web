import { localDayKey, parseUtc } from '@/utils/dateAttribution'

export interface StorageSnapshot {
  taken_at: string
  object_count: number
  total_bytes: number
}

export function snapshotDateKey(value: string): string {
  return localDayKey(parseUtc(value))
}

export function formatSnapshotDate(key: string): string {
  const [year, month, day] = key.split('-').map(Number)
  return `${month}/${day}`
}

export function buildStorageTrend(
  byCategory: Record<string, StorageSnapshot[]>,
  categories: readonly { key: string }[],
) {
  const dates = [...new Set(
    Object.values(byCategory).flatMap(list => list.map(snapshot => snapshotDateKey(snapshot.taken_at))),
  )].sort()

  const datasets = categories.map(category => {
    const byDate = new Map(
      (byCategory[category.key] || []).map(snapshot => [snapshotDateKey(snapshot.taken_at), snapshot]),
    )
    return {
      dates,
      values: dates.map(date => {
        const snapshot = byDate.get(date)
        return snapshot ? +(snapshot.total_bytes / 1024 / 1024).toFixed(1) : null
      }),
    }
  })

  return { dates, datasets }
}
