import { computed, nextTick, ref, shallowRef } from 'vue'

type NavigationEntry = { id: string }

export interface FolderNavigationOptions<Entry extends NavigationEntry> {
  initial?: Entry[]
  onChange?: () => void
}

/** 路径浏览器共享的导航栈与前进/后退历史，不负责加载内容或权限判断。 */
export function useFolderNavigation<Entry extends NavigationEntry>(options: FolderNavigationOptions<Entry>) {
  const folderStack = shallowRef<Entry[]>([...(options.initial ?? [])])
  const history = shallowRef<Entry[][]>([[...folderStack.value]])
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

  function enterFolder(folder: Entry) {
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

  function reset() {
    folderStack.value = []
    history.value = [[]]
    cursor.value = 0
  }

  return { folderStack, canGoBack, canGoForward, enterFolder, navigateTo, goBack, goForward, reset }
}
