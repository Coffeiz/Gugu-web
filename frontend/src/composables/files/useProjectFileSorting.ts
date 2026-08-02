import { computed, type Ref } from 'vue'
import type { FileMeta, FolderMeta } from '@/stores/filesCache'
import { fileExtCategory } from '@/utils/fileTypes'
import { projectFileDirectory } from '@/composables/files/useFileProjection'

/** 项目文件区的排序派生，统一目录排序规则，视图层只消费已排序数据。 */
export function useProjectFileSorting(options: {
  folders: Ref<FolderMeta[]>
  files: Ref<FileMeta[]>
  sortKey: Ref<string>
  sortDir: Ref<'asc' | 'desc'>
}) {
  const sortedDirectory = computed(() => projectFileDirectory(
    options.folders.value,
    options.files.value,
    options.sortKey.value,
    options.sortDir.value,
    {
      folderSorters: {
        name: folder => folder.name,
        type: folder => folder.name,
        id: folder => folder.id,
      },
      fileSorters: {
        name: file => file.displayName,
        type: file => `${fileExtCategory(file.ext)}:${file.ext ?? ''}`,
        stage: file => file.stageName ?? '',
        createdAt: file => file.createdAt,
        size: file => file.sizeBytes ?? 0,
        id: file => file.id,
      },
    },
  ))

  return {
    sortedFolders: computed(() => sortedDirectory.value.folders),
    sortedFiles: computed(() => sortedDirectory.value.files),
  }
}
