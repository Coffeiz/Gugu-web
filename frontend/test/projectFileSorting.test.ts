import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { useProjectFileSorting } from '@/composables/files/useProjectFileSorting'

describe('useProjectFileSorting', () => {
  it('按当前排序字段返回文件夹和文件', () => {
    const result = useProjectFileSorting({
      folders: ref([{ id: 2, name: '乙' }, { id: 1, name: '甲' }] as any),
      files: ref([
        { id: 2, displayName: '乙.txt', ext: 'txt', sizeBytes: 2 },
        { id: 1, displayName: '甲.txt', ext: 'txt', sizeBytes: 1 },
      ] as any),
      sortKey: ref('name'),
      sortDir: ref('asc'),
    })

    expect(result.sortedFolders.value.map(folder => folder.name)).toEqual(['甲', '乙'])
    expect(result.sortedFiles.value.map(file => file.displayName)).toEqual(['甲.txt', '乙.txt'])
  })

  it('切换排序方向会同步更新派生结果', () => {
    const sortDir = ref<'asc' | 'desc'>('asc')
    const result = useProjectFileSorting({
      folders: ref([]),
      files: ref([{ id: 1, displayName: 'a', ext: 'txt' }, { id: 2, displayName: 'b', ext: 'txt' }] as any),
      sortKey: ref('name'),
      sortDir,
    })
    sortDir.value = 'desc'
    expect(result.sortedFiles.value.map(file => file.displayName)).toEqual(['b', 'a'])
  })
})
