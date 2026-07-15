import type { UploadItem } from '@/composables/useFileUpload'

export interface UploadGroup {
  name: string
  total: number
}

/** 返回当前上传批次需要显示顶层 ghost 的文件夹，不改变原始上传顺序。 */
export function getTopLevelUploadGroups(items: UploadItem[]): UploadGroup[] {
  const totals = new Map<string, number>()
  for (const item of items) {
    const separator = item.relativePath.indexOf('/')
    if (separator === -1) continue
    const name = item.relativePath.slice(0, separator)
    totals.set(name, (totals.get(name) ?? 0) + 1)
  }
  return [...totals].map(([name, total]) => ({ name, total }))
}
