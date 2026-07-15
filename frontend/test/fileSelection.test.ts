import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { selectRange, useFileSelection } from '@/composables/files/useFileSelection'

describe('selectRange', () => {
  it('按锚点和目标位置返回文件与文件夹集合', () => {
    const items = [
      { type: 'folder' as const, id: 'f:1' },
      { type: 'file' as const, id: 2 },
      { type: 'folder' as const, id: 'f:3' },
      { type: 'file' as const, id: 4 },
    ]
    expect(selectRange(items, 3, 1)).toEqual({
      fileIds: new Set([2, 4]),
      folderIds: new Set(['f:3']),
    })
  })

  it('锚点无效时不产生选择结果', () => {
    expect(selectRange([{ type: 'file' as const, id: 1 }], -1, 0)).toBeNull()
  })

  it('单选文件会清空文件夹选择，重复点击可取消', () => {
    const fileIds = ref(new Set<number>([2]))
    const folderIds = ref(new Set<string>(['f:1']))
    const selection = useFileSelection({ fileIds, folderIds })

    selection.toggleExclusiveFile(3)
    expect(fileIds.value).toEqual(new Set([3]))
    expect(folderIds.value).toEqual(new Set())

    selection.toggleExclusiveFile(3)
    expect(fileIds.value).toEqual(new Set())
    expect(folderIds.value).toEqual(new Set())
  })

  it('单选文件夹与文件使用同一互斥规则', () => {
    const fileIds = ref(new Set<number>([2]))
    const folderIds = ref(new Set<string>())
    const selection = useFileSelection({ fileIds, folderIds })

    selection.toggleExclusiveFolder('f:1')
    expect(fileIds.value).toEqual(new Set())
    expect(folderIds.value).toEqual(new Set(['f:1']))
  })
})
