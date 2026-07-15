import { describe, expect, it } from 'vitest'
import { selectRange } from '@/composables/files/useFileSelection'

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
})
