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

  return { uploadingItems, createGhost, updateGhostProgress, removeGhost, failGhost }
}
