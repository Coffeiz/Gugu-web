import { ref } from 'vue'

export function useUploadQueue() {
  const uploadingItems = ref([])
  let _uid = 0

  function createGhost(name, ext) {
    const ghost = { uid: ++_uid, name, ext, progress: 0, error: false }
    uploadingItems.value.push(ghost)
    return ghost
  }

  function updateGhostProgress(ghost, p) {
    const g = uploadingItems.value.find(g => g.uid === ghost.uid)
    if (g) g.progress = Math.round(p * 100)
  }

  function removeGhost(ghost) {
    uploadingItems.value = uploadingItems.value.filter(g => g.uid !== ghost.uid)
  }

  function failGhost(ghost) {
    const g = uploadingItems.value.find(g => g.uid === ghost.uid)
    if (g) g.error = true
    setTimeout(() => removeGhost(ghost), 2000)
  }

  // ── 文件夹级幽灵卡：拖一个文件夹进来时，里面每个文件不再各出一张卡（一大堆文件名刷屏、
  // 大部分还落在当前看不见的子文件夹里意义不大），汇总成「文件夹名 · 完成数/总数」一张卡。
  function createFolderGhost(name, total) {
    const ghost = { uid: ++_uid, name, isFolder: true, total, done: 0, failed: 0, progress: 0, error: false }
    uploadingItems.value.push(ghost)
    return ghost
  }

  // 文件夹内一个文件完成（成功/失败都算「处理完」，失败额外记一笔）——按完成数推进整体进度，
  // 不做逐字节聚合（文件数量一多，逐文件 progress 事件汇总反而抖动，done/total 更稳定直观）。
  function bumpFolderGhost(ghost, failed = false) {
    const g = uploadingItems.value.find(g => g.uid === ghost.uid)
    if (!g) return
    g.done++
    if (failed) g.failed++
    g.progress = Math.round((g.done / g.total) * 100)
    if (g.done >= g.total) {
      if (g.failed > 0) g.error = true
      setTimeout(() => removeGhost(g), g.failed > 0 ? 2000 : 600)
    }
  }

  return {
    uploadingItems, createGhost, updateGhostProgress, removeGhost, failGhost,
    createFolderGhost, bumpFolderGhost,
  }
}
