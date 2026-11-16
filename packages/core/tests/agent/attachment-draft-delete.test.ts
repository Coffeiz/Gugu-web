import { describe, expect, it, vi } from 'vitest'
import { createChatAttachmentDraftDeleter } from '../../src/agent/attachments/delete-draft.js'

describe('聊天附件草稿删除用例', () => {
  it('owner 的 draft 删除后才清理未引用字节并返回 Python 回执', async () => {
    const order: string[] = []
    const removeDraft = vi.fn(async () => { order.push('row'); return { storageKey: 'owner/.chat_staging/a.txt' } })
    const removeUnreferenced = vi.fn(async () => { order.push('bytes'); return true })
    const remove = createChatAttachmentDraftDeleter({ removeDraft, removeUnreferenced })
    await expect(remove('owner', 'attach')).resolves.toEqual({ deleted: true })
    expect(removeDraft).toHaveBeenCalledWith('owner', 'attach')
    expect(removeUnreferenced).toHaveBeenCalledWith('owner', 'owner/.chat_staging/a.txt')
    expect(order).toEqual(['row', 'bytes'])
  })

  it('owner 不存在附件时返回 404 且不触碰存储', async () => {
    const removeUnreferenced = vi.fn(async () => true)
    const remove = createChatAttachmentDraftDeleter({
      async removeDraft() { return null }, removeUnreferenced,
    })
    await expect(remove('owner', 'missing')).rejects.toMatchObject({ code: 'not_found', message: '附件不存在' })
    expect(removeUnreferenced).not.toHaveBeenCalled()
  })

  it('附件已经 attached 时返回 409 且不触碰存储', async () => {
    const removeUnreferenced = vi.fn(async () => true)
    const remove = createChatAttachmentDraftDeleter({
      async removeDraft() { return 'already-used' }, removeUnreferenced,
    })
    await expect(remove('owner', 'attached')).rejects.toMatchObject({ code: 'conflict', message: '附件已被使用，无法删除' })
    expect(removeUnreferenced).not.toHaveBeenCalled()
  })
})
