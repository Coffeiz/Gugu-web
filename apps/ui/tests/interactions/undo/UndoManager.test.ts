/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { undoApi } from '@/services/api'
import { UndoManager, isEditableTarget, undoShortcutMode } from '@/interaction/undo/UndoManager'

describe('UndoManager 快捷键边界', () => {
  afterEach(() => vi.restoreAllMocks())

  it('不拦截输入控件和可编辑区域', () => {
    const input = document.createElement('input')
    const editor = document.createElement('div')
    editor.setAttribute('contenteditable', 'true')
    expect(isEditableTarget(input)).toBe(true)
    expect(isEditableTarget(editor)).toBe(true)
    expect(isEditableTarget(document.body)).toBe(false)
  })

  it('项目弹层接管文件重做，编辑框保留原生快捷键', () => {
    const overlay = document.body.appendChild(document.createElement('div'))
    overlay.className = 'bm-overlay'
    const input = overlay.appendChild(document.createElement('input'))
    const listener = (event: KeyboardEvent) => {
      expect(undoShortcutMode(event)).toBeUndefined()
      expect(undoShortcutMode(event, true)).toBe(event.target === input ? undefined : 'redo')
    }
    overlay.addEventListener('keydown', listener)
    try {
      for (const target of [overlay, input])
        target.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: true, bubbles: true }))
    } finally { overlay.remove() }
  })

  it('Ctrl/Cmd+Z 选择 undo，Shift 组合选择 redo', async () => {
    const preview = vi.spyOn(undoApi, 'preview').mockResolvedValue({
      available: true,
      redo_available: true,
      undo: { operation_id: 'op-undo', summary: '创建 1 个对象', resource: 'files', action: 'create', target_count: 1 },
      redo: { operation_id: 'op-redo', summary: '创建 1 个对象', resource: 'files', action: 'create', target_count: 1 },
    })
    const undo = vi.spyOn(undoApi, 'undo').mockResolvedValue({})
    const redo = vi.spyOn(undoApi, 'redo').mockResolvedValue({})
    const manager = new UndoManager()
    manager.start()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))
    await vi.waitFor(() => expect(undo).toHaveBeenCalledWith('op-undo'))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: true, bubbles: true }))
    await vi.waitFor(() => expect(redo).toHaveBeenCalledWith('op-redo'))
    await Promise.resolve()
    expect(preview).toHaveBeenCalledTimes(2)
    expect(undo).toHaveBeenCalledWith('op-undo')
    expect(redo).toHaveBeenCalledWith('op-redo')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true }))
    await vi.waitFor(() => expect(redo).toHaveBeenCalledTimes(2))

    const overlay = document.body.appendChild(document.createElement('div'))
    overlay.className = 'bm-overlay'
    try {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))
      expect(undo).toHaveBeenCalledTimes(1)
    } finally {
      overlay.remove()
      manager.stop()
    }
  })
})
