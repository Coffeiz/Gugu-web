import { ref } from 'vue'
import { defineStore } from 'pinia'

export const useClipboardStore = defineStore('clipboard', () => {
  const type    = ref(null)  // 'cut' | 'copy'
  const fileIds = ref([])
  const folderIds = ref([])

  function cut(fids = [], dids = []) {
    type.value = 'cut'; fileIds.value = fids; folderIds.value = dids
  }
  function copy(fids = [], dids = []) {
    type.value = 'copy'; fileIds.value = fids; folderIds.value = dids
  }
  function clear() {
    type.value = null; fileIds.value = []; folderIds.value = []
  }
  const hasContent = () => fileIds.value.length > 0 || folderIds.value.length > 0

  return { type, fileIds, folderIds, cut, copy, clear, hasContent }
})
