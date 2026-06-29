import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { filesApi, foldersApi } from '@/services/api'
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

  // 实时：咕咕/IM 改了文件库 → 已加载过就重新拉取（无条件 refresh）。
  // ⚠️ 别在这里改走 _checkVersion 做版本门控——/files/version 的 GET 可能被浏览器缓存、拿到旧版本号
  //    → 以为没变就不刷新 → IM 存文件后项目卡片文件数不实时更新（踩过）。卡顿修复靠 live.js 重连错峰，
  //    不靠这里省刷新。
  watch(() => useLiveStore().rev.files, () => { if (loaded.value) refresh() })

  return {
    allFiles, allFolders, loaded, loading,
    load, refresh,
    getPersonalRootFiles, getProjectRootFiles, getFolderFiles,
    getPersonalRootFolders, getProjectRootFolders, getSubFolders,
    addFile, removeFile, removeFiles, updateFile, getFile,
    addFolder, removeFolder, updateFolder, getFolder,
  }
})
