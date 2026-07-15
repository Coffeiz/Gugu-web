import type { UploadItem } from '@/composables/useFileUpload'
import { checkUploadConflicts } from '@/composables/useFileUpload'
import type { ConflictDecision, ConflictItem } from '@/components/common/UploadConflictDialog.vue'

export interface UploadGroup {
  name: string
  total: number
}

export interface UploadConflictContext {
  space: string
  projectId: number | null
  folderId: number | null
}

export async function resolveUploadConflicts(
  items: UploadItem[],
  context: UploadConflictContext,
  showDialog: (conflicts: ConflictItem[]) => Promise<Map<string, ConflictDecision>>,
): Promise<{ items: UploadItem[]; decisions: Map<string, ConflictDecision> }> {
  const conflicts = await checkUploadConflicts(items, context)
  if (!conflicts.length) return { items, decisions: new Map() }
  const decisions = await showDialog(conflicts)
  return {
    items: items.filter(item => decisions.get(item.relativePath)?.action !== 'skip'),
    decisions,
  }
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
