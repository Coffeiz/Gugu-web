import { type Ref } from 'vue'
import type { FileMeta, FolderMeta } from '@/stores/filesCache'
import { fileExtCategory } from '@/utils/fileTypes'
import { useFileSorting } from './useFileSorting'

/** 项目文件区的排序派生，统一目录排序规则，视图层只消费已排序数据。 */
export function useProjectFileSorting(options: {
  folders: Ref<FolderMeta[]>
  files: Ref<FileMeta[]>
  sortKey: Ref<string>
  sortDir: Ref<'asc' | 'desc'>
}) {
  return useFileSorting({
    folders: options.folders,
    files: options.files,
    sortKey: options.sortKey,
    sortDir: options.sortDir,
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
  })
}
