import type { UploadItem } from '@/composables/files/useFileUploadCore'
import { checkUploadConflicts, uploadFilesWithFolders } from '@/composables/files/useFileUploadCore'
import type { ConflictDecision, ConflictItem } from '@/components/common/overlays/UploadConflictDialog.vue'
import { splitName } from '@/utils/fileParse'

export interface UploadGroup {
  name: string
  total: number
}

export interface UploadConflictContext {
  space: string
  projectId: number | null
  folderId: number | null
}

export interface PreparedUploadBatch {
  items: UploadItem[]
  decisions: Map<string, ConflictDecision>
  folderGroups: UploadGroup[]
}

export interface UploadLifecycleOptions<G, F extends { id: number; projectId?: number | null; parentId?: number | null; name: string }> {
  projectId: number | null
  baseFolderId: number | null
  folderGroups: UploadGroup[]
  decisions: Map<string, ConflictDecision>
  createGhost: (name: string, ext: string) => G
  updateGhostProgress: (ghost: G, progress: number) => void
  removeGhost: (ghost: G) => void
  failGhost: (ghost: G) => void
  createFolderGhost: (name: string, total: number) => G
  bumpFolderGhost: (ghost: G, failed: boolean) => void
  onFolderCreated: (folder: F, isTopLevel: boolean) => void
  onTopFolderReady: (name: string) => void
  uploadOne: (
    file: File,
    folderId: number | null,
    relativePath: string,
    decision: ConflictDecision | undefined,
    onProgress: (progress: number) => void,
  ) => Promise<void>
  onUploadError?: (error: unknown) => void
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

/** 统一上传前的冲突决策和顶层文件夹进度分组，不承接上传副作用。 */
export async function prepareUploadBatch(
  items: UploadItem[],
  context: UploadConflictContext,
  showDialog: (conflicts: ConflictItem[]) => Promise<Map<string, ConflictDecision>>,
): Promise<PreparedUploadBatch> {
  const resolved = await resolveUploadConflicts(items, context, showDialog)
  return {
    ...resolved,
    folderGroups: getTopLevelUploadGroups(resolved.items),
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

/**
 * 统一上传 ghost 生命周期；实际网络请求和缓存写入由页面回调负责。
 * 顶层文件夹在所有文件 settle 前保持 ghost，避免真实文件夹与进度卡同时出现。
 */
export async function executeUploadLifecycle<
  G,
  F extends { id: number; projectId?: number | null; parentId?: number | null; name: string },
>(items: UploadItem[], options: UploadLifecycleOptions<G, F>): Promise<void> {
  const folderGhosts = new Map<string, G>()
  const folderDone = new Map<string, number>()
  for (const group of options.folderGroups) {
      folderGhosts.set(group.name, options.createFolderGhost(group.name, group.total))
    folderDone.set(group.name, 0)
  }

  await uploadFilesWithFolders(items, {
    projectId: options.projectId,
    baseFolderId: options.baseFolderId,
    onFolderCreated: (folder) => {
      options.onFolderCreated(
        folder as F,
        folderGhosts.has(folder.name) && (folder.parentId ?? null) === options.baseFolderId,
      )
    },
    uploadOne: async (file, resolvedFolderId, relativePath) => {
      const top = relativePath.includes('/') ? relativePath.slice(0, relativePath.indexOf('/')) : null
      const folderGhost = top ? folderGhosts.get(top) : undefined
      const { base, ext } = splitName(file.name)
      const ghost = folderGhost ? null : options.createGhost(base, ext.toUpperCase())
      const settleFolder = (failed: boolean) => {
        if (!folderGhost || !top) return
        options.bumpFolderGhost(folderGhost, failed)
        const group = options.folderGroups.find(item => item.name === top)
        const done = (folderDone.get(top) ?? 0) + 1
        folderDone.set(top, done)
        if (group && done >= group.total) options.onTopFolderReady(top)
      }

      try {
        await options.uploadOne(
          file,
          resolvedFolderId,
          relativePath,
          options.decisions.get(relativePath),
          progress => { if (ghost) options.updateGhostProgress(ghost, progress) },
        )
        if (ghost) options.removeGhost(ghost)
        else settleFolder(false)
      } catch (error) {
        if (ghost) options.failGhost(ghost)
        else settleFolder(true)
        options.onUploadError?.(error)
      }
    },
  })
}
