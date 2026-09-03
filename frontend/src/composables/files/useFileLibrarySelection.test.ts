import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useFileLibrarySelection } from './useFileLibrarySelection'

/** 回归：folder 与 file 是两张独立自增主键表，id 会撞号；Shift 范围选择的
 * 查找必须同时匹配 type，否则会锚进另一张表的同号项目，范围整体错位。 */
describe('useFileLibrarySelection shift 范围选择', () => {
  it('file 与 folder 撞号时范围选择按 type 定位', () => {
    const folders = [{ id: 20 }]
    const files = [
      { id: 12, ext: 'txt', displayName: 'a.txt' },
      { id: 20, ext: 'txt', displayName: 'b.txt' },
    ] as never[]
    const sel = useFileLibrarySelection({
      containerRef: ref(null),
      currentType: ref('all'),
      getFolders: () => folders,
      getFiles: () => files,
      getTrashFolders: () => [],
      enterFolder: vi.fn(),
      openPreview: vi.fn(),
      isPreviewable: () => true,
    })
    // Ctrl+点 file:12 建立锚点（位于扁平表的 index 1）
    sel.handleFileClick(files[0], { ctrlKey: true } as MouseEvent)
    expect(sel.selectedIds.value.has(12)).toBe(true)
    // Shift+点 file:20：错误实现会先撞上 folder:20（index 0），范围倒挂
    sel.handleFileClick(files[1], { shiftKey: true } as MouseEvent)
    expect(sel.selectedIds.value.has(12)).toBe(true)
    expect(sel.selectedIds.value.has(20)).toBe(true)
    expect(sel.selectedFolderKeys.value.size).toBe(0)
  })
})
