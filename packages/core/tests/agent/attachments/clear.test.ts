import { describe, expect, it, vi } from 'vitest'
import { createChatAttachmentDraftClearer } from '../../../src/agent/attachments/clear-drafts.js'

describe('聊天附件批量草稿清理用例', () => {
  it('按 owner 删除 draft 行，去重清理共享字节，并计入旧 Redis 草稿', async () => {
    const calls: string[] = []
    const removeUnreferenced = vi.fn(async (_owner: string, key: string) => {
      calls.push(`bytes:${key}`)
      return key !== 'owner/shared.txt'
    })
    const clearLegacy = vi.fn(async (_owner: string, cleanup: (key: string) => Promise<unknown>) => {
      calls.push('redis')
      await cleanup('owner/legacy.txt')
      return 1
    })
    const clear = createChatAttachmentDraftClearer({
      async deleteDraftRows(owner) { calls.push(`rows:${owner}`); return ['owner/a.txt', 'owner/a.txt', 'owner/shared.txt'] },
      removeUnreferenced,
      clearLegacy,
    })
    await expect(clear('owner')).resolves.toEqual({ deleted: 2 })
    expect(removeUnreferenced).toHaveBeenCalledTimes(3)
    expect(calls).toEqual(['rows:owner', 'bytes:owner/a.txt', 'bytes:owner/shared.txt', 'redis', 'bytes:owner/legacy.txt'])
    expect(clearLegacy).toHaveBeenCalledWith('owner', expect.any(Function))
  })

  it('没有草稿或旧记录时返回零且不伪报物理删除', async () => {
    const removeUnreferenced = vi.fn(async () => false)
    const clear = createChatAttachmentDraftClearer({
      async deleteDraftRows() { return ['owner/shared.txt'] },
      removeUnreferenced,
      async clearLegacy() { return 0 },
    })
    await expect(clear('owner')).resolves.toEqual({ deleted: 0 })
  })
})
