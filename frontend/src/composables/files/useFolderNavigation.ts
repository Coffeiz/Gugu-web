import { computed, nextTick, ref, type Ref } from 'vue'
import type { FolderMeta } from '@/stores/filesCache'

export interface FolderNavigationOptions {
  initial?: FolderMeta[]
  onChange?: () => void
}

/** 文件浏览通用的目录栈与前进/后退历史，不负责加载内容或权限判断。 */
export function useFolderNavigation(options: FolderNavigationOptions = {}) {
  const folderStack = ref<FolderMeta[]>([...(options.initial ?? [])])
  const history = ref<FolderMeta[][]>([[...folderStack.value]])
  const cursor = ref(0)
  let replaying = false

  const canGoBack = computed(() => cursor.value > 0)
  const canGoForward = computed(() => cursor.value < history.value.length - 1)

  function pushHistory() {
    if (replaying) return
    history.value = history.value.slice(0, cursor.value + 1)
    history.value.push([...folderStack.value])
    cursor.value = history.value.length - 1
  }

  function enterFolder(folder: FolderMeta) {
    folderStack.value = [...folderStack.value, folder]
    pushHistory()
    options.onChange?.()
  }

  function navigateTo(index: number) {
    folderStack.value = index < 0 ? [] : folderStack.value.slice(0, index + 1)
    pushHistory()
    options.onChange?.()
  }

  function goBack() {
    if (!canGoBack.value) return
    replaying = true
    cursor.value--
    folderStack.value = [...history.value[cursor.value]]
    options.onChange?.()
    nextTick(() => { replaying = false })
  }

  function goForward() {
    if (!canGoForward.value) return
    replaying = true
    cursor.value++
    folderStack.value = [...history.value[cursor.value]]
    options.onChange?.()
    nextTick(() => { replaying = false })
  }

  function pruneHistoryForFolders(folderIds: Iterable<number>) {
    const ids = new Set(folderIds)
    const kept = history.value.filter(snapshot => !snapshot.some(folder => ids.has(folder.id)))
    history.value = kept.length ? kept : [[]]
    cursor.value = Math.min(cursor.value, history.value.length - 1)
  }

  function reset() {
    folderStack.value = []
    history.value = [[]]
    cursor.value = 0
  }

  return { folderStack, canGoBack, canGoForward, enterFolder, navigateTo, goBack, goForward, pruneHistoryForFolders, reset }
}
