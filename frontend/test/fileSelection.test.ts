import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { selectRange, useFileSelection } from '@/composables/files/useFileSelection'
import { resolveSelectionAnchor } from '@/composables/files/useSelectionState'

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

  it('连续 Shift 选择保持第一次点击的锚点', () => {
    const items = Array.from({ length: 10 }, (_, index) => ({ type: 'file' as const, id: index + 1 }))
    const anchor = 0
    expect(selectRange(items, anchor, 4)?.fileIds).toEqual(new Set([1, 2, 3, 4, 5]))
    expect(selectRange(items, anchor, 9)?.fileIds).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))
    expect(resolveSelectionAnchor(anchor, 9, true)).toBe(anchor)
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

  it('替换混合文件和文件夹的范围选择', () => {
    const fileIds = ref(new Set<number>())
    const folderIds = ref(new Set<number>())
    const selection = useFileSelection({ fileIds, folderIds })

    expect(selection.selectRangeIn([
      { type: 'folder', id: 8 },
      { type: 'file', id: 3 },
      { type: 'folder', id: 9 },
    ], 0, 2)).toBe(true)
    expect(fileIds.value).toEqual(new Set([3]))
    expect(folderIds.value).toEqual(new Set([8, 9]))
  })
})
