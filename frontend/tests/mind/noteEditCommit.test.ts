// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { commitNoteEdit } from '@/composables/mind/noteEditCommit'

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
})
