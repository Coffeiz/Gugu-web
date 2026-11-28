import { defineStore } from 'pinia'
import { shallowReactive, watch } from 'vue'
import { filesApi } from '@/services/api'
import { useLiveStore } from '@/stores/live'
import type { LiveEventPayload } from '@/types/live-events'
import { getAccountBoundaryEpoch } from '@/utils/accountBoundary'

/** 文件库元数据以路径为身份；不依赖旧 OpenAPI 中的文件/文件夹 ID 字段。 */
export interface FileMeta {
  filePath?: string
  folderPath?: string | null
  displayName?: string
  ext?: string
  space?: string
  workspaceDirectoryId?: number | null
  projectId?: number | null
  projectName?: string | null
  projectColor?: string | null
  stageName?: string
  mindMapId?: number | null
  size?: string
  sizeBytes?: number
  mimeType?: string | null
  createdAt?: string
  deletedAt?: string | null
  imgWidth?: number | null
  imgHeight?: number | null
  version?: number
  thumbRevision?: number
  versions?: Array<{ size?: string }>
  /** 聊天附件仍由附件系统自己的字符串标识引用，不是文件库 ID。 */
  attach_id?: string | null
}

const MAX_CACHED_DETAILS = 600

function touch<T>(map: Map<string, T>, id: string, value: T) {
  map.delete(id)
  map.set(id, value)
  while (map.size > MAX_CACHED_DETAILS) map.delete(map.keys().next().value!)
}

export const useFilesCacheStore = defineStore('filesCache', () => {
  // 只缓存被明确读取的文件元数据，文件浏览由磁盘路径 API 负责。
  const filesByPath = shallowReactive(new Map<string, FileMeta>())
  const fileLookups = new Map<string, Promise<FileMeta | null>>()

  function addFile(file: FileMeta) { if (typeof file.filePath === 'string') touch(filesByPath, file.filePath, file) }
  function removeFile(filePath: string) { filesByPath.delete(filePath) }
  function removeFiles(filePaths: string[]) { for (const filePath of filePaths) filesByPath.delete(filePath) }
  function updateFile(filePath: string, patch: Partial<FileMeta>) {
    const current = filesByPath.get(filePath)
    if (current) touch(filesByPath, filePath, { ...current, ...patch })
  }
  function getFile(filePath: string) { return filesByPath.get(filePath) ?? null }

  async function ensureFile(filePath: string): Promise<FileMeta | null> {
    const cached = getFile(filePath)
    if (cached) { touch(filesByPath, filePath, cached); return cached }
    const epoch = getAccountBoundaryEpoch()
    const key = `${epoch}:${filePath}`
    const pending = fileLookups.get(key)
    if (pending) return pending
    const request = filesApi.get(filePath).then(file => {
      if (epoch !== getAccountBoundaryEpoch()) return null
      const value = file as FileMeta
      touch(filesByPath, filePath, value)
      return value
    }).catch(error => {
      if ((error as { status?: number }).status === 404) return null
      throw error
    }).finally(() => fileLookups.delete(key))
    fileLookups.set(key, request)
    return request
  }

  function resetAccountState() {
    filesByPath.clear()
    fileLookups.clear()
  }

  function applyCanonicalEvent(event: LiveEventPayload): boolean {
    const filePath = typeof event.entity_id === 'string' ? event.entity_id : ''
    if (!filePath) return false
    const wrapped = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : null
    if (wrapped?.kind !== 'file') return false
    if (event.operation === 'delete') {
      const existed = filesByPath.has(filePath)
      removeFile(filePath)
      return existed
    }
    const value = (wrapped.entity ?? wrapped) as Record<string, unknown>
    if (!value || typeof value !== 'object' || value.filePath !== filePath) return false
    addFile(value as unknown as FileMeta)
    return true
  }

  watch(() => useLiveStore().resourceEvent, event => {
    if (event?.resource === 'files') applyCanonicalEvent(event)
  }, { immediate: true })

  return { filesByPath, addFile, removeFile, removeFiles, updateFile, getFile, ensureFile, resetAccountState, applyCanonicalEvent }
})
