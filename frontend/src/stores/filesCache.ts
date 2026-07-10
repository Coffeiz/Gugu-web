import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { filesApi, foldersApi, CLIENT_ID } from '@/services/api'
import { useLiveStore } from '@/stores/live'

let _lastVersion = null
let _visibilityBound = false

export const useFilesCacheStore = defineStore('filesCache', () => {
  const allFiles   = ref([])
  const allFolders = ref([])
  const loaded     = ref(false)
  const loading    = ref(false)

  // ── 索引 ──────────────────────────────────────────────────────────────────
  // files key: folderId (int) | 'proj:{id}' | 'personal'
  const _fileIdx = computed(() => {
    const m = new Map()
    for (const f of allFiles.value) {
      const key = f.folderId != null
        ? f.folderId
        : f.projectId != null ? `proj:${f.projectId}` : 'personal'
      if (!m.has(key)) m.set(key, [])
      m.get(key).push(f)
    }
    return m
  })

  // folders key: 'personal' | 'proj:{id}' | 'sub:{parentId}'
  const _folderIdx = computed(() => {
    const m = new Map()
    for (const f of allFolders.value) {
      const key = f.parentId != null
        ? `sub:${f.parentId}`
        : f.projectId != null ? `proj:${f.projectId}` : 'personal'
      if (!m.has(key)) m.set(key, [])
      m.get(key).push(f)
    }
    return m
  })

  // ── 查找 ──────────────────────────────────────────────────────────────────
  const getPersonalRootFiles   = ()          => _fileIdx.value.get('personal')            ?? []
  const getProjectRootFiles    = (projectId) => _fileIdx.value.get(`proj:${projectId}`)   ?? []
  const getFolderFiles         = (folderId)  => _fileIdx.value.get(folderId)               ?? []

  const getPersonalRootFolders = ()          => _folderIdx.value.get('personal')           ?? []
  const getProjectRootFolders  = (projectId) => _folderIdx.value.get(`proj:${projectId}`)  ?? []
  const getSubFolders          = (parentId)  => _folderIdx.value.get(`sub:${parentId}`)    ?? []

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
      console.error('[filesCache] 加载失败:', e.message)
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
  function addFile(file) {
    allFiles.value = [file, ...allFiles.value]
  }

  function removeFile(id) {
    allFiles.value = allFiles.value.filter(f => f.id !== id)
  }

  function removeFiles(ids) {
    const set = new Set(ids)
    allFiles.value = allFiles.value.filter(f => !set.has(f.id))
  }

  function updateFile(id, patch) {
    allFiles.value = allFiles.value.map(f => f.id === id ? { ...f, ...patch } : f)
  }

  function getFile(id) {
    return allFiles.value.find(f => f.id === id) ?? null
  }

  // ── 乐观更新：文件夹 ──────────────────────────────────────────────────────
  function addFolder(folder) {
    allFolders.value = [...allFolders.value, folder]
  }

  function removeFolder(id) {
    const toRemove = new Set()
    const collect = (fid) => {
      toRemove.add(fid)
      for (const sub of getSubFolders(fid)) collect(sub.id)
    }
    collect(id)
    allFolders.value = allFolders.value.filter(f => !toRemove.has(f.id))
    allFiles.value   = allFiles.value.filter(f => !toRemove.has(f.folderId))
  }

  function updateFolder(id, patch) {
    allFolders.value = allFolders.value.map(f => f.id === id ? { ...f, ...patch } : f)
  }

  function getFolder(id) {
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
