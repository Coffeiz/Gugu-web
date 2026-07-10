import { ref } from 'vue'
import { defineStore } from 'pinia'

export const useClipboardStore = defineStore('clipboard', () => {
  const type    = ref<'cut' | 'copy' | null>(null)
  const fileIds = ref<number[]>([])
  const folderIds = ref<number[]>([])

  function cut(fids: number[] = [], dids: number[] = []) {
    type.value = 'cut'; fileIds.value = fids; folderIds.value = dids
  }
  function copy(fids: number[] = [], dids: number[] = []) {
    type.value = 'copy'; fileIds.value = fids; folderIds.value = dids
  }
  function clear() {
    type.value = null; fileIds.value = []; folderIds.value = []
  }
  const hasContent = () => fileIds.value.length > 0 || folderIds.value.length > 0

  return { type, fileIds, folderIds, cut, copy, clear, hasContent }
})
