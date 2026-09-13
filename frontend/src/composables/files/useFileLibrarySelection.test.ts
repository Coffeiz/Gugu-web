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

/** 回归：重命名输入框在手势中途因 blur 提交被卸载，浏览器会把 click 改派到
 * 释放点元素——拖选重命名文字后松开在别的文件卡上会误开预览。卡片点击必须
 * 要求「按下也发生在同一张卡内」。 */
describe('useFileLibrarySelection 点击手势一致性', () => {
  function makeCard(className = 'fc-card'): HTMLElement {
    const card = document.createElement('div')
    card.className = className
    document.body.appendChild(card)
    return card
  }

  function pressWithin(target: Element) {
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  }

  it('按下在别的卡（重命名拖选）：click 不开预览', () => {
    const cardA = makeCard()
    const cardB = makeCard()
    const openPreview = vi.fn()
    const file = { id: 7, ext: 'png', displayName: 'a.png' } as never
    const sel = useFileLibrarySelection({
      containerRef: ref(null),
      currentType: ref('all'),
      getFolders: () => [],
      getFiles: () => [file],
      getTrashFolders: () => [],
      enterFolder: vi.fn(),
      openPreview,
      isPreviewable: () => true,
    })

    // 按下发生在 A 卡（重命名输入框所在），释放落在 B 卡上。
    pressWithin(cardA)
    sel.handleFileClick(file, { currentTarget: cardB } as unknown as MouseEvent)
    expect(openPreview).not.toHaveBeenCalled()

    // 按下与释放在同一张卡：正常开预览。
    pressWithin(cardB)
    sel.handleFileClick(file, { currentTarget: cardB } as unknown as MouseEvent)
    expect(openPreview).toHaveBeenCalledWith(file)

    // 按下在同卡的子元素（如名称行）也视为同卡手势。
    const label = document.createElement('div')
    cardB.appendChild(label)
    pressWithin(label)
    sel.handleFileClick(file, { currentTarget: cardB } as unknown as MouseEvent)
    expect(openPreview).toHaveBeenCalledTimes(2)

    cardA.remove()
    cardB.remove()
  })

  it('按下滑在可编辑区（重命名输入框）：无论输入框是否卸载、同卡或跨卡，都不开预览', () => {
    const cardA = makeCard()
    const input = document.createElement('input')
    cardA.appendChild(input)
    const openPreview = vi.fn()
    const file = { id: 8, ext: 'png', displayName: 'b.png' } as never
    const sel = useFileLibrarySelection({
      containerRef: ref(null),
      currentType: ref('all'),
      getFolders: () => [],
      getFiles: () => [file],
      getTrashFolders: () => [],
      enterFolder: vi.fn(),
      openPreview,
      isPreviewable: () => true,
    })

    // 用户时序（探针实测）：按下落在输入框内，blur 提交与 click 派发的先后
    // 是竞态——两种顺序都必须忽略，不能开预览。
    pressWithin(input)
    input.remove()
    sel.handleFileClick(file, { currentTarget: cardA } as unknown as MouseEvent)
    expect(openPreview).not.toHaveBeenCalled()

    pressWithin(input)
    cardA.appendChild(input)
    sel.handleFileClick(file, { currentTarget: cardA } as unknown as MouseEvent)
    expect(openPreview).not.toHaveBeenCalled()

    // 跨卡变体：输入框在 A 卡，释放落在 B 卡。
    const cardB = makeCard()
    pressWithin(input)
    sel.handleFileClick(file, { currentTarget: cardB } as unknown as MouseEvent)
    expect(openPreview).not.toHaveBeenCalled()

    // 正常卡面按下不受守卫影响。
    pressWithin(cardA)
    sel.handleFileClick(file, { currentTarget: cardA } as unknown as MouseEvent)
    expect(openPreview).toHaveBeenCalledTimes(1)

    cardA.remove()
    cardB.remove()
  })
})
