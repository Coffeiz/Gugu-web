import { nextTick, ref, watch, type Ref } from 'vue'
import type { FolderMeta } from '@/stores/filesCache'
import type { Project } from '@/types/project'

type FileCacheLike = { loaded: boolean; loading: boolean; load: () => void | Promise<void> }

/** 项目切换时同步文件工作区导航与全局缓存，避免弹窗层重复维护生命周期细节。 */
export function useProjectFileProjectSync(options: {
  project: () => Project | null
  openFolders: Ref<Set<number>>
  folderStack: Ref<FolderMeta[]>
  resetNavigation: () => void
  showNewFolder: Ref<boolean>
  resetDraft: (project: Project | null) => void
  fileCacheStore: FileCacheLike
}) {
  const initializing = ref(false)
  watch(() => options.project()?.id, async id => {
    initializing.value = true
    options.resetDraft(options.project())
    options.openFolders.value = new Set<number>()
    options.folderStack.value = []
    options.resetNavigation()
    options.showNewFolder.value = false
    await nextTick()
    initializing.value = false
    if (!id) return
    if (!options.fileCacheStore.loaded && !options.fileCacheStore.loading) {
      await options.fileCacheStore.load()
    }
  }, { immediate: true })

  return { initializing }
}
