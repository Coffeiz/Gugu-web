import { computed, type ComputedRef, type Ref } from 'vue'
import type { FileMeta } from '@/stores/filesCache'
import type { FolderCard as FolderCardMeta } from '@/utils/filesNav'
import { fileExtCategory } from '@/utils/fileTypes'
import { projectFileDirectory } from '@/composables/files/useFileProjection'

type Contents = { folders: FolderCardMeta[]; files: FileMeta[] }

interface SortingOptions {
  contents: Ref<Contents>
  currentType: Ref<string>
  sortKey: Ref<string>
  sortDir: Ref<'asc' | 'desc'>
}

export function useFileLibrarySorting(options: SortingOptions): ComputedRef<Contents> {
  const { contents, currentType, sortKey, sortDir } = options
  return computed(() => {
    const { folders, files } = contents.value
    // projects 层是「状态文件夹」，保持看板顺序（待开始→进行中→已完成），不参与排序
    if (currentType.value === 'root' || currentType.value === 'projects') return { folders, files }
    return projectFileDirectory(folders, files, sortKey.value, sortDir.value, {
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
  })
}
