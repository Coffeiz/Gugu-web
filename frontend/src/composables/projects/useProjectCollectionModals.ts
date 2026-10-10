import { ref, watch } from 'vue'

interface ProjectCollectionLoaders {
  loadArchived: () => Promise<unknown>
  loadDeleted: () => Promise<unknown>
}

/** 归档与回收站仅在用户打开对应弹窗时加载。 */
export function useProjectCollectionModals(loaders: ProjectCollectionLoaders) {
  const showArchived = ref(false)
  const showDeleted = ref(false)

  watch(showArchived, open => {
    if (open) void loaders.loadArchived()
  })
  watch(showDeleted, open => {
    if (open) void loaders.loadDeleted()
  })

  return { showArchived, showDeleted }
}
