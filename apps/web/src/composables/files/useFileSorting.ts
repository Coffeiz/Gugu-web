import { computed, type ComputedRef, type Ref } from 'vue'
import { projectFileDirectory, type FileProjectionSorters } from './useFileProjection'

export interface FileSortingOptions<Folder, File> {
  folders: Ref<Folder[]>
  files: Ref<File[]>
  sortKey: Ref<string>
  sortDir: Ref<'asc' | 'desc'>
  folderSorters: FileProjectionSorters<Folder>
  fileSorters: FileProjectionSorters<File>
  /** 根目录/项目状态目录可保持业务原有顺序，不参与排序。 */
  preserveOrder?: () => boolean
}

/** 文件库和项目文件区共用的排序派生入口；不持有排序状态，也不执行 API。 */
export function useFileSorting<Folder, File>(options: FileSortingOptions<Folder, File>) {
  const sortedDirectory = computed(() => {
    if (options.preserveOrder?.()) {
      return { folders: options.folders.value, files: options.files.value }
    }
    return projectFileDirectory(
      options.folders.value,
      options.files.value,
      options.sortKey.value,
      options.sortDir.value,
      { folderSorters: options.folderSorters, fileSorters: options.fileSorters },
    )
  })

  return {
    sortedDirectory: sortedDirectory as ComputedRef<{ folders: Folder[]; files: File[] }>,
    sortedFolders: computed(() => sortedDirectory.value.folders),
    sortedFiles: computed(() => sortedDirectory.value.files),
  }
}

