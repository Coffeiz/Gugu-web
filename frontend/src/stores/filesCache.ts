import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { filesApi, foldersApi, CLIENT_ID } from '@/services/api'
import { useLiveStore } from '@/stores/live'
import type { components } from '@/types/api'

// 文件/文件夹领域类型：核心字段绑定 OpenAPI 生成的响应体（filesApi.all / foldersApi.all 的返回）。
// 文件对象在各视图里是「带客户端增补的袋子」——已知 wire 字段照常有类型，另留少量历史/客户端字段
// 与索引签名，容纳消费方现存用法（如聊天附件预览携带 attach_id、旧面板仍读 versions）。
export type FileMeta = components['schemas']['FileResponse'] & {
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
    try {
      const [files, folders, ver] = await Promise.all([filesApi.all(), foldersApi.all(), filesApi.version()])
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
    try {
      const [files, folders, ver] = await Promise.all([filesApi.all(), foldersApi.all(), filesApi.version()])
      allFiles.value   = files
      allFolders.value = folders
      _lastVersion = ver?.version ?? null
    } catch { /* 静默失败 */ }
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
  function addFolder(folder: { id: number; name: string; projectId?: number | null; parentId?: number | null; fileCount?: number }) {
    allFolders.value = [...allFolders.value, {
      id: folder.id, name: folder.name,
      projectId: folder.projectId ?? null,
      parentId:  folder.parentId ?? null,
      fileCount: folder.fileCount ?? 0,
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

  // ── 细粒度实时同步：消费 live.fileEvent（Tier 3-B）──────────────────────────
  // 三种处理：
  //  ① 回声抑制：origin === 本页 client-id → 本页发起的改动，早已乐观更新过，跳过（不再全量重拉自己）。
  //  ② remove 快路径：别的标签页/端删了文件/文件夹 → 本地直接剔除（零网络），文件夹级联剔子树。
  //  ③ 其余（add/update/移动/批量/重连补刷）：合并防抖后全量 refresh —— 这些需要 join 后的完整实体
  //     （projectName/color/排序等），本地拼不出，仍靠重拉；防抖把一串事件收敛成一次重拉。
  // ⚠️ 别改成 _checkVersion 版本门控——/files/version 的 GET 可能被浏览器缓存拿到旧版本号 → 漏刷（踩过）。
  let _refreshTimer: ReturnType<typeof setTimeout> | null = null
  function _scheduleRefresh() {
    if (_refreshTimer) return
    _refreshTimer = setTimeout(() => { _refreshTimer = null; if (loaded.value) refresh() }, 80)
  }
  watch(() => useLiveStore().fileEvent, (ev) => {
    if (!ev || !loaded.value) return
    if (ev.origin && ev.origin === CLIENT_ID) return          // ① 回声抑制
    if (ev.op === 'remove') {                                  // ② remove 快路径
      const ids = ev.ids ?? (ev.id != null ? [ev.id] : [])
      if (ev.kind === 'folder') ids.forEach(id => removeFolder(id))
      else removeFiles(ids)
    } else {
      _scheduleRefresh()                                       // ③ 合并全量刷新
    }
  })

  return {
    allFiles, allFolders, loaded, loading,
    load, refresh,
    getPersonalRootFiles, getProjectRootFiles, getFolderFiles,
    getPersonalRootFolders, getProjectRootFolders, getSubFolders,
    addFile, removeFile, removeFiles, updateFile, getFile,
    addFolder, removeFolder, updateFolder, getFolder,
  }
})
