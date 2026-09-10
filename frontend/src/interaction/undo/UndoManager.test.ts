/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { undoApi } from '@/services/api'
import { UndoManager, isEditableTarget } from './UndoManager'

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
    await vi.waitFor(() => expect(preview).toHaveBeenCalledTimes(2))
    expect(undo).toHaveBeenCalledWith('op-undo')
    expect(redo).toHaveBeenCalledWith('op-redo')
    manager.stop()
  })
})
