import { naturalCompare } from '@/utils/textSort'

export type SortDirection = string

function directionValue(direction: SortDirection) {
  return direction === 'asc' ? 1 : -1
}

function compareText(a: unknown, b: unknown, direction: SortDirection) {
  // 自然数序（"文件 10" > "文件 4"），跨 ASCII 字符串（ISO 时间/ext）行为跟原 .localeCompare() 一致
  return directionValue(direction) * naturalCompare(String(a ?? ''), String(b ?? ''))
}

function compareId(a: unknown, b: unknown, direction: SortDirection) {
  const left = Number(a)
  const right = Number(b)
  return directionValue(direction) * (left > right ? 1 : left < right ? -1 : 0)
}

export interface FileProjectionSorters<T> {
  name: (item: T) => unknown
  type: (item: T) => unknown
  stage?: (item: T) => unknown
  createdAt?: (item: T) => unknown
  size?: (item: T) => number
  id: (item: T) => unknown
}

/** 只负责把当前目录数据投影为排序后的数组，不持有页面状态或执行 API。 */
export function sortFileProjection<T>(items: readonly T[], key: string, direction: SortDirection,
  sorters: FileProjectionSorters<T>): T[] {
  return [...items].sort((a, b) => {
    if (key === 'name') return compareText(sorters.name(a), sorters.name(b), direction)
    if (key === 'type') return compareText(sorters.type(a), sorters.type(b), direction)
    if (key === 'stage' && sorters.stage) return compareText(sorters.stage(a), sorters.stage(b), direction)
    if (key === 'createdAt' && sorters.createdAt) return compareText(sorters.createdAt(a), sorters.createdAt(b), direction)
    if (key === 'size' && sorters.size) return directionValue(direction) * (sorters.size(a) - sorters.size(b))
    return compareId(sorters.id(a), sorters.id(b), direction)
  })
}
