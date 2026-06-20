import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { filesApi, foldersApi } from '@/services/api'

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
    allFiles.value   = allFiles.value.map(f =>
      toRemove.has(f.folderId) ? { ...f, folderId: null } : f
    )
  }

  function updateFolder(id, patch) {
    allFolders.value = allFolders.value.map(f => f.id === id ? { ...f, ...patch } : f)
  }

  function getFolder(id) {
    return allFolders.value.find(f => f.id === id) ?? null
  }

  return {
    allFiles, allFolders, loaded, loading,
    load, refresh,
    getPersonalRootFiles, getProjectRootFiles, getFolderFiles,
    getPersonalRootFolders, getProjectRootFolders, getSubFolders,
    addFile, removeFile, removeFiles, updateFile, getFile,
    addFolder, removeFolder, updateFolder, getFolder,
  }
})
