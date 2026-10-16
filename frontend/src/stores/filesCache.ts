import { defineStore } from 'pinia'
import { shallowReactive, watch } from 'vue'
import { filesApi, foldersApi, type CursorPage } from '@/services/api'
import { useLiveStore } from '@/stores/live'
import type { components } from '@/types/api'
import type { LiveEventPayload } from '@/types/live-events'
import { getAccountBoundaryEpoch } from '@/utils/accountBoundary'

export type FileMeta = components['schemas']['FileResponse'] & {
  workspaceDirectoryId?: number | null
  thumbRevision?: number
  versions?: Array<{ size?: string }>
  attach_id?: number | string | null
  file_id?: number | null
}
export type FolderMeta = components['schemas']['FolderResponse'] & {
  workspaceDirectoryId?: number | null
}

export interface DirectorySnapshotScope {
  space: 'personal' | 'project' | 'workspace'
  projectId?: number
  folderId?: number
  workspaceDirectoryId?: number
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
}

export interface DirectoryPageState {
  files: FileMeta[]
  folders: FolderMeta[]
  fileCursor: string | null
  folderCursor: string | null
  fileHasMore: boolean
  folderHasMore: boolean
}

const MAX_DIRECTORY_CACHES = 8
const MAX_CACHED_DIRECTORY_ENTITIES = 2000
const MAX_CACHED_DETAILS = 600

function directoryKey(scope: DirectorySnapshotScope): string {
  return [scope.space, scope.projectId ?? 0, scope.workspaceDirectoryId ?? 0,
    scope.folderId ?? 0, scope.sortBy ?? 'createdAt', scope.sortOrder ?? 'desc'].join(':')
}

function touch<T>(map: Map<number, T>, id: number, value: T) {
  map.delete(id)
  map.set(id, value)
  while (map.size > MAX_CACHED_DETAILS) map.delete(map.keys().next().value!)
}

export const useFilesCacheStore = defineStore('filesCache', () => {
  // 仅缓存明确读取的 ID 和目录页；容量有上限，缓存未命中不代表实体不存在。
  const filesById = shallowReactive(new Map<number, FileMeta>())
  const foldersById = shallowReactive(new Map<number, FolderMeta>())
  const directories = shallowReactive(new Map<string, DirectoryPageState>())
  // 目录重新验证期间保留上一次页面，避免实体变更触发失效时文件区闪成空白。
  const staleDirectories = shallowReactive(new Map<string, DirectoryPageState>())
  // LRU 次序不属于目录数据；保持非响应式，避免缓存读取在 computed 中改写自己的依赖。
  const directoryAccessOrder = new Map<string, true>()
  const fileLookups = new Map<string, Promise<FileMeta | null>>()
  const folderLookups = new Map<string, Promise<FolderMeta | null>>()

  function getDirectory(scope: DirectorySnapshotScope): DirectoryPageState | null {
    const key = directoryKey(scope)
    const entry = directories.get(key)
    if (!entry) return null
    directoryAccessOrder.delete(key)
    directoryAccessOrder.set(key, true)
    return entry
  }

  function getDirectorySnapshot(scope: DirectorySnapshotScope): DirectoryPageState | null {
    return getDirectory(scope) ?? staleDirectories.get(directoryKey(scope)) ?? null
  }

  function rememberDirectory(scope: DirectorySnapshotScope, entry: DirectoryPageState) {
    const key = directoryKey(scope)
    staleDirectories.delete(key)
    directories.delete(key)
    directories.set(key, entry)
    directoryAccessOrder.delete(key)
    directoryAccessOrder.set(key, true)
    for (const file of entry.files) touch(filesById, file.id, file)
    for (const folder of entry.folders) touch(foldersById, folder.id, folder)
    const entityCount = () => [...directories.values()].reduce((count, page) => count + page.files.length + page.folders.length, 0)
    while (directories.size > MAX_DIRECTORY_CACHES || entityCount() > MAX_CACHED_DIRECTORY_ENTITIES) {
      const oldestKey = directoryAccessOrder.keys().next().value as string | undefined
      if (oldestKey == null) break
      directoryAccessOrder.delete(oldestKey)
      directories.delete(oldestKey)
    }
  }

  function setDirectoryPage(
    scope: DirectorySnapshotScope,
    files: CursorPage<FileMeta>,
    folders: CursorPage<FolderMeta>,
    append = false,
  ) {
    const previous = append ? getDirectory(scope) : null
    const nextFiles = append ? [...(previous?.files ?? []), ...files.items] : [...files.items]
    const nextFolders = append ? [...(previous?.folders ?? []), ...folders.items] : [...folders.items]
    const dedupe = <T extends { id: number }>(items: T[]) => [...new Map(items.map(item => [item.id, item])).values()]
    rememberDirectory(scope, {
      files: dedupe(nextFiles), folders: dedupe(nextFolders),
      fileCursor: files.next_cursor ?? (append ? previous?.fileCursor ?? null : null),
      folderCursor: folders.next_cursor ?? (append ? previous?.folderCursor ?? null : null),
      fileHasMore: files.has_more,
      folderHasMore: folders.has_more,
    })
  }

  function invalidatePages(scope?: DirectorySnapshotScope) {
    if (scope) {
      const key = directoryKey(scope)
      const previous = directories.get(key)
      if (previous) {
        staleDirectories.delete(key)
        staleDirectories.set(key, previous)
      }
      directories.delete(key)
      directoryAccessOrder.delete(key)
    } else {
      for (const [key, previous] of directories) {
        staleDirectories.delete(key)
        staleDirectories.set(key, previous)
      }
      directories.clear()
      directoryAccessOrder.clear()
    }
    while (staleDirectories.size > MAX_DIRECTORY_CACHES) {
      staleDirectories.delete(staleDirectories.keys().next().value!)
    }
  }

  function getPersonalRootFiles(sortBy?: string, sortOrder?: 'asc' | 'desc') { return getDirectory({ space: 'personal', sortBy, sortOrder })?.files ?? [] }
  function getProjectRootFiles(projectId: number, sortBy?: string, sortOrder?: 'asc' | 'desc') { return getDirectory({ space: 'project', projectId, sortBy, sortOrder })?.files ?? [] }
  function getFolderFiles(folderId: number, sortBy?: string, sortOrder?: 'asc' | 'desc') {
    const folder = getFolder(folderId)
    return getDirectory({
      space: folder?.workspaceDirectoryId != null ? 'workspace' : folder?.projectId != null ? 'project' : 'personal',
      ...(folder?.projectId != null ? { projectId: folder.projectId } : {}),
      ...(folder?.workspaceDirectoryId != null ? { workspaceDirectoryId: folder.workspaceDirectoryId } : {}),
      folderId, sortBy, sortOrder,
    })?.files ?? []
  }
  function getWorkspaceFiles(workspaceDirectoryId: number, folderId: number | null = null, sortBy?: string, sortOrder?: 'asc' | 'desc') {
    return getDirectory({ space: 'workspace', workspaceDirectoryId, ...(folderId != null ? { folderId } : {}), sortBy, sortOrder })?.files ?? []
  }
  function getProjectRootFolders(projectId: number, sortBy?: string, sortOrder?: 'asc' | 'desc') { return getDirectory({ space: 'project', projectId, sortBy, sortOrder })?.folders ?? [] }
  function getSubFolders(parentId: number, sortBy?: string, sortOrder?: 'asc' | 'desc') { return getDirectoryForFolder(parentId, sortBy, sortOrder)?.folders ?? [] }
  function getWorkspaceFolders(workspaceDirectoryId: number, parentId: number | null = null, sortBy?: string, sortOrder?: 'asc' | 'desc') {
    return getDirectory({ space: 'workspace', workspaceDirectoryId, ...(parentId != null ? { folderId: parentId } : {}), sortBy, sortOrder })?.folders ?? []
  }

  function getDirectoryForFolder(folderId: number, sortBy?: string, sortOrder?: 'asc' | 'desc') {
    const folder = getFolder(folderId)
    if (!folder) return null
    const scope: DirectorySnapshotScope = {
      space: folder.workspaceDirectoryId != null ? 'workspace' : folder.projectId != null ? 'project' : 'personal',
      ...(folder.projectId != null ? { projectId: folder.projectId } : {}),
      ...(folder.workspaceDirectoryId != null ? { workspaceDirectoryId: folder.workspaceDirectoryId } : {}),
      folderId, sortBy, sortOrder,
    }
    return getDirectory(scope)
  }

  function addFile(file: FileMeta) { touch(filesById, file.id, file); invalidatePages() }
  function removeFile(id: number) {
    filesById.delete(id)
    invalidatePages()
  }
  function removeFiles(ids: number[]) {
    const remove = new Set(ids)
    for (const id of remove) filesById.delete(id)
    invalidatePages()
  }
  function updateFile(id: number, patch: Partial<FileMeta>) {
    const current = filesById.get(id)
    if (current) touch(filesById, id, { ...current, ...patch })
    invalidatePages()
  }
  function getFile(id: number) { return filesById.get(id) ?? null }

  async function ensureFile(id: number): Promise<FileMeta | null> {
    const cached = getFile(id)
    if (cached) { touch(filesById, id, cached); return cached }
    const epoch = getAccountBoundaryEpoch()
    const key = `${epoch}:${id}`
    const pending = fileLookups.get(key)
    if (pending) return pending
    const request = filesApi.get(id).then(file => {
      if (epoch !== getAccountBoundaryEpoch()) return null
      touch(filesById, file.id, file as FileMeta)
      return file as FileMeta
    }).catch(error => {
      if ((error as { status?: number }).status === 404) return null
      throw error
    }).finally(() => fileLookups.delete(key))
    fileLookups.set(key, request)
    return request
  }

  function addFolder(folder: { id: number; name: string; projectId?: number | null; workspaceDirectoryId?: number | null; parentId?: number | null; fileCount?: number; version?: number }) {
    touch(foldersById, folder.id, {
      id: folder.id, name: folder.name, projectId: folder.projectId ?? null,
      workspaceDirectoryId: folder.workspaceDirectoryId ?? null, parentId: folder.parentId ?? null,
      fileCount: folder.fileCount ?? 0, version: folder.version ?? 1,
    } as FolderMeta)
    invalidatePages()
  }
  function getFolder(id: number) { return foldersById.get(id) ?? null }
  async function ensureFolder(id: number): Promise<FolderMeta | null> {
    const cached = getFolder(id)
    if (cached) { touch(foldersById, id, cached); return cached }
    const epoch = getAccountBoundaryEpoch()
    const key = `${epoch}:${id}`
    const pending = folderLookups.get(key)
    if (pending) return pending
    const request = foldersApi.get(id).then(folder => {
      if (epoch !== getAccountBoundaryEpoch()) return null
      const normalized = folder as FolderMeta
      touch(foldersById, normalized.id, normalized)
      return normalized
    }).catch(error => {
      if ((error as { status?: number }).status === 404) return null
      throw error
    }).finally(() => folderLookups.delete(key))
    folderLookups.set(key, request)
    return request
  }
  function removeFolder(id: number) {
    const removed = new Set<number>([id])
    let changed = true
    while (changed) {
      changed = false
      for (const folder of foldersById.values()) {
        if (folder.parentId != null && removed.has(folder.parentId) && !removed.has(folder.id)) {
          removed.add(folder.id); changed = true
        }
      }
    }
    for (const folderId of removed) foldersById.delete(folderId)
    invalidatePages()
  }
  function updateFolder(id: number, patch: Partial<FolderMeta>) {
    const folder = getFolder(id)
    if (folder) touch(foldersById, id, { ...folder, ...patch })
    invalidatePages()
  }

  function resetAccountState() {
    directories.clear(); staleDirectories.clear(); directoryAccessOrder.clear(); filesById.clear(); foldersById.clear()
    fileLookups.clear(); folderLookups.clear()
  }

  function applyCanonicalEvent(event: LiveEventPayload): boolean {
    const id = Number(event.entity_id)
    if (!Number.isFinite(id)) return false
    const wrapped = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : null
    const kind = wrapped?.kind === 'folder' || wrapped?.kind === 'file' ? wrapped.kind : null
    const value = (wrapped?.entity ?? wrapped) as Record<string, unknown> | null
    if (event.operation === 'delete') {
      const known = filesById.has(id) || foldersById.has(id)
      removeFile(id)
      if (foldersById.has(id)) removeFolder(id)
      invalidatePages()
      return known
    }
    if (!value || typeof value !== 'object') { invalidatePages(); return false }
    if (kind === 'folder' || (!kind && 'fileCount' in value && !('storageKey' in value))) {
      if (Number(value.id) !== id) { invalidatePages(); return false }
      addFolder(value as unknown as FolderMeta)
    } else {
      if (Number(value.id) !== id) { invalidatePages(); return false }
      addFile(value as unknown as FileMeta)
    }
    invalidatePages()
    return true
  }

  watch(() => useLiveStore().resourceEvent, event => {
    if (event?.resource === 'files') applyCanonicalEvent(event)
  }, { immediate: true })

  // Agent 本地流在 tool_done/回合完成时会 bump rev.files 作为确定性刷新信号，
  // 但该路径不一定伴随 canonical resourceEvent。目录页必须同时失效，避免重开面板命中旧快照。
  watch(() => useLiveStore().rev.files, () => invalidatePages())

  return {
    directories, getDirectory, getDirectorySnapshot, setDirectoryPage, invalidatePages,
    getPersonalRootFiles, getProjectRootFiles, getFolderFiles, getWorkspaceFiles,
    getProjectRootFolders, getSubFolders, getWorkspaceFolders,
    addFile, removeFile, removeFiles, updateFile, getFile, ensureFile,
    addFolder, removeFolder, updateFolder, getFolder, ensureFolder, resetAccountState,
  }
})
