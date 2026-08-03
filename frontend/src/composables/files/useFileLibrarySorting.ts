import { computed, type ComputedRef, type Ref } from 'vue'
import type { FileMeta } from '@/stores/filesCache'
import type { FolderCard as FolderCardMeta } from '@/utils/filesNav'
import { fileExtCategory } from '@/utils/fileTypes'
import { useFileSorting } from './useFileSorting'

type Contents = { folders: FolderCardMeta[]; files: FileMeta[] }

interface SortingOptions {
  contents: Ref<Contents>
  currentType: Ref<string>
  sortKey: Ref<string>
  sortDir: Ref<'asc' | 'desc'>
}

export function useFileLibrarySorting(options: SortingOptions): ComputedRef<Contents> {
  const { contents, currentType, sortKey, sortDir } = options
  const sorted = useFileSorting({
    folders: computed(() => contents.value.folders),
    files: computed(() => contents.value.files),
    sortKey,
    sortDir,
    preserveOrder: () => currentType.value === 'root' || currentType.value === 'projects',
    folderSorters: { name: folder => folder.displayName, type: folder => folder.displayName, id: folder => folder.id },
    fileSorters: {
      name: file => file.displayName,
      type: file => `${fileExtCategory(file.ext)}:${file.ext ?? ''}`,
      stage: file => file.projectName || file.stageName || '',
      createdAt: file => file.createdAt,
      size: file => file.sizeBytes ?? 0,
      id: file => file.id,
    },
  })
  return computed(() => sorted.sortedDirectory.value)
}
