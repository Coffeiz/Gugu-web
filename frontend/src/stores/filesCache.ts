import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { filesApi, foldersApi } from '@/services/api'
import { useLiveStore } from '@/stores/live'
import type { components } from '@/types/api'
import type { LiveEventPayload } from '@/types/live-events'
import { getAccountBoundaryEpoch } from '@/utils/accountBoundary'
import { InteractionSyncEventQueue } from '@/interaction/sync/InteractionSyncEventQueue'

// 文件/文件夹领域类型：核心字段绑定 OpenAPI 生成的响应体（filesApi.all / foldersApi.all 的返回）。
// 文件对象在各视图里是「带客户端增补的袋子」——已知 wire 字段照常有类型，另留少量历史/客户端字段
// 与索引签名，容纳消费方现存用法（如聊天附件预览携带 attach_id、旧面板仍读 versions）。
export type FileMeta = components['schemas']['FileResponse'] & {
  /** 覆盖上传/粘贴覆盖后强制缩略图指令重建节点。 */
  thumbRevision?: number
  versions?: Array<{ size?: string }>   // 历史字段：wire 现已直接给 size，个别面板仍读 versions
  attach_id?: number | string | null    // 聊天附件预览时携带（非库文件）
  file_id?: number | null
}
export type FolderMeta = components['schemas']['FolderResponse']

let _lastVersion: string | number | null = null
let _visibilityBound = false

export const useFilesCacheStore = defineStore('filesCache', () => {
  const allFiles   = ref<FileMeta[]>([])
  const allFolders = ref<FolderMeta[]>([])
  const loaded     = ref(false)
  const loading    = ref(false)

  // ── 索引 ──────────────────────────────────────────────────────────────────
  // files key: folderId (int) | 'proj:{id}' | 'personal'
  const _fileIdx = computed(() => {
    const m = new Map<number | string, FileMeta[]>()
    for (const f of allFiles.value) {
      const key = f.folderId != null
        ? f.folderId
        : f.projectId != null ? `proj:${f.projectId}` : 'personal'
      if (!m.has(key)) m.set(key, [])
      m.get(key)!.push(f)
    }
    return m
  })

  // folders key: 'personal' | 'proj:{id}' | 'sub:{parentId}'
  const _folderIdx = computed(() => {
    const m = new Map<string, FolderMeta[]>()
    for (const f of allFolders.value) {
      const key = f.parentId != null
        ? `sub:${f.parentId}`
        : f.projectId != null ? `proj:${f.projectId}` : 'personal'
      if (!m.has(key)) m.set(key, [])
      m.get(key)!.push(f)
    }
    return m
  })

  // ── 查找 ──────────────────────────────────────────────────────────────────
  const getPersonalRootFiles   = ()          => _fileIdx.value.get('personal')            ?? []
  const getProjectRootFiles    = (projectId: number) => _fileIdx.value.get(`proj:${projectId}`)   ?? []
  const getFolderFiles         = (folderId: number)  => _fileIdx.value.get(folderId)               ?? []

  const getPersonalRootFolders = ()          => _folderIdx.value.get('personal')           ?? []
  const getProjectRootFolders  = (projectId: number) => _folderIdx.value.get(`proj:${projectId}`)  ?? []
  const getSubFolders          = (parentId: number)  => _folderIdx.value.get(`sub:${parentId}`)    ?? []

  // ── 加载 ──────────────────────────────────────────────────────────────────
  async function load() {
    if (loading.value) return
    loading.value = true
    const requestEpoch = getAccountBoundaryEpoch()
    try {
      const [files, folders, ver] = await Promise.all([filesApi.all(), foldersApi.all(), filesApi.version()])
      if (requestEpoch !== getAccountBoundaryEpoch()) return
      allFiles.value   = files
      allFolders.value = folders
      loaded.value     = true
      _lastVersion = ver?.version ?? null
    } catch (e) {
      console.error('[filesCache] 加载失败:', e instanceof Error ? e.message : e)
    } finally {
      loading.value = false
    }
    _bindVisibility()
  }

  async function refresh() {
    const requestEpoch = getAccountBoundaryEpoch()
    try {
      const [files, folders, ver] = await Promise.all([filesApi.all(), foldersApi.all(), filesApi.version()])
      if (requestEpoch !== getAccountBoundaryEpoch()) return
      allFiles.value   = files
      allFolders.value = folders
      _lastVersion = ver?.version ?? null
    } catch { /* 静默失败 */ }
  }

  function resetAccountState() {
    eventQueue.cancel()
    allFiles.value = []
    allFolders.value = []
    loaded.value = false
    loading.value = false
    _lastVersion = null
  }

  async function _checkVersion() {
    if (!loaded.value) return
    try {
      const ver = await filesApi.version()
      if (ver?.version && ver.version !== _lastVersion) {
        await refresh()
      }
    } catch { /* 静默失败 */ }
  }

  function _bindVisibility() {
    if (_visibilityBound) return
    _visibilityBound = true
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') _checkVersion()
    })
  }

  // ── 乐观更新：文件 ────────────────────────────────────────────────────────
  function addFile(file: FileMeta) {
    allFiles.value = [file, ...allFiles.value]
  }

  function removeFile(id: number) {
    allFiles.value = allFiles.value.filter(f => f.id !== id)
  }

  function removeFiles(ids: number[]) {
    const set = new Set(ids)
    allFiles.value = allFiles.value.filter(f => !set.has(f.id))
  }

  function updateFile(id: number, patch: Partial<FileMeta>) {
    allFiles.value = allFiles.value.map(f => f.id === id ? { ...f, ...patch } : f)
  }

  function getFile(id: number) {
    return allFiles.value.find(f => f.id === id) ?? null
  }

  // ── 乐观更新：文件夹 ──────────────────────────────────────────────────────
  // 上传链路新建的文件夹可能不带 fileCount（useFileUpload 的 onFolderCreated 未标该字段）——
  // 新建文件夹本就 0 文件，缺省补 0，保证入库的都是完整 FolderMeta。
  function addFolder(folder: { id: number; name: string; projectId?: number | null; parentId?: number | null; fileCount?: number; version?: number }) {
    allFolders.value = [...allFolders.value, {
      id: folder.id, name: folder.name,
      projectId: folder.projectId ?? null,
      parentId:  folder.parentId ?? null,
      fileCount: folder.fileCount ?? 0,
      version:   folder.version ?? 1,
    }]
  }

  function removeFolder(id: number) {
    const toRemove = new Set()
    const collect = (fid: number) => {
      toRemove.add(fid)
      for (const sub of getSubFolders(fid)) collect(sub.id)
    }
    collect(id)
    allFolders.value = allFolders.value.filter(f => !toRemove.has(f.id))
    allFiles.value   = allFiles.value.filter(f => !toRemove.has(f.folderId))
  }

  function updateFolder(id: number, patch: Partial<FolderMeta>) {
    allFolders.value = allFolders.value.map(f => f.id === id ? { ...f, ...patch } : f)
  }

  function getFolder(id: number) {
    return allFolders.value.find(f => f.id === id) ?? null
  }

  function applyCanonicalEvent(event: LiveEventPayload): boolean {
    const id = Number(event.entity_id)
    if (!Number.isFinite(id)) return false
    const wrapped = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, any> : null
    const kind = wrapped?.kind === 'folder' || wrapped?.kind === 'file' ? wrapped.kind : null
    const value = wrapped?.entity ?? wrapped
    if (event.operation === 'delete') {
      const hadFile = allFiles.value.some(file => file.id === id)
      const hadFolder = allFolders.value.some(folder => folder.id === id)
      removeFiles([id])
      if (hadFolder) removeFolder(id)
      return hadFile || hadFolder
    }
    if (!value || typeof value !== 'object') return false
    if (kind === 'folder' || (!kind && 'fileCount' in value && !('storageKey' in value))) {
      const folder = value as FolderMeta
      if (Number(folder.id) !== id) return false
      const index = allFolders.value.findIndex(item => item.id === id)
      if (event.operation === 'create' && index < 0) allFolders.value = [folder, ...allFolders.value]
      else if (index >= 0) allFolders.value.splice(index, 1, folder)
      else return false
      return true
    }
    const file = value as FileMeta
    if (Number(file.id) !== id) return false
    const index = allFiles.value.findIndex(item => item.id === id)
    if (event.operation === 'create' && index < 0) allFiles.value = [file, ...allFiles.value]
    else if (index >= 0) allFiles.value.splice(index, 1, file)
    else return false
    return true
  }

  // ── canonical 实时同步：能增量应用实体就直接应用，否则合并重拉。 ──
  // 三种处理：
  //  ① 回声抑制：origin === 本页 client-id → 本页发起的改动，早已乐观更新过，跳过（不再全量重拉自己）。
  //  ② remove 快路径：别的标签页/端删了文件/文件夹 → 本地直接剔除（零网络），文件夹级联剔子树。
  //  ③ 其余（add/update/移动/批量/重连补刷）：合并防抖后全量 refresh —— 这些需要 join 后的完整实体
  //     （projectName/color/排序等），本地拼不出，仍靠重拉；防抖把一串事件收敛成一次重拉。
  // ⚠️ 别改成 _checkVersion 版本门控——/files/version 的 GET 可能被浏览器缓存拿到旧版本号 → 漏刷（踩过）。
  const eventQueue = new InteractionSyncEventQueue()
  eventQueue.register('files', applyCanonicalEvent, () => { if (loaded.value) void refresh() })
  watch(() => useLiveStore().resourceEvent, (event) => {
    if (!event || event.resource !== 'files' || !loaded.value) return
    eventQueue.receive(event)
  })

  return {
    allFiles, allFolders, loaded, loading,
    load, refresh, resetAccountState,
    getPersonalRootFiles, getProjectRootFiles, getFolderFiles,
    getPersonalRootFolders, getProjectRootFolders, getSubFolders,
    addFile, removeFile, removeFiles, updateFile, getFile,
    addFolder, removeFolder, updateFolder, getFolder,
  }
})
