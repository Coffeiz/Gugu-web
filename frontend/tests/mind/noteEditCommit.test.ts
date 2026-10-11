// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { canLeaveNoteEditor, commitNoteEdit } from '@/composables/mind/noteEditCommit'

describe('笔记保存状态', () => {
  it('保存失败保留编辑态和输入，成功重试后才退出编辑', async () => {
    const editing = ref(true)
    const committing = ref(false)
    const save = vi.fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)

    await expect(commitNoteEdit(editing, committing, save)).resolves.toBe(false)
    expect(editing.value).toBe(true)
    expect(committing.value).toBe(false)

    await expect(commitNoteEdit(editing, committing, save)).resolves.toBe(true)
    expect(editing.value).toBe(false)
    expect(committing.value).toBe(false)
  })

  it('离页保存失败时阻止导航，成功后才允许离开', async () => {
    const finishEdit = vi.fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)

    await expect(canLeaveNoteEditor(true, finishEdit)).resolves.toBe(false)
    await expect(canLeaveNoteEditor(true, finishEdit)).resolves.toBe(true)
    await expect(canLeaveNoteEditor(false, finishEdit)).resolves.toBe(true)
    expect(finishEdit).toHaveBeenCalledTimes(2)
  })
})
