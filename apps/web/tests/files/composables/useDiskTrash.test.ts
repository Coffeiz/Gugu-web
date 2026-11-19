import { effectScope, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import { useDiskTrash } from '@/composables/files/useDiskTrash'
import { diskTrashApi, type DiskTrashEntry } from '@/services/api'

vi.mock('@/composables/core/useConfirmDialog', () => ({ confirmDialog: vi.fn() }))
vi.mock('@/composables/core/useAppToast', () => ({
  errorMessage: String, showAppError: vi.fn(), showAppSuccess: vi.fn(),
}))
vi.mock('@/i18n', () => ({ i18n: { global: { t: (key: string) => key } } }))
vi.mock('@/services/api', () => ({ diskTrashApi: { list: vi.fn(), purge: vi.fn(), restore: vi.fn() } }))

const file: DiskTrashEntry = { id: '文件', name: '文件.txt', relativePath: '文件.txt', kind: 'file', deletedAt: '2026-01-01T00:00:00Z' }
const folder: DiskTrashEntry = { id: '目录', name: '目录', relativePath: '目录', kind: 'directory', deletedAt: '2026-01-01T00:00:00Z' }

describe('磁盘回收站的批量操作', () => {
  let scope: ReturnType<typeof effectScope>
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(diskTrashApi.list).mockResolvedValue([file, folder])
    scope = effectScope()
  })
  afterEach(() => scope.stop())

  it('取消清空时保留磁盘条目且不发删除请求', async () => {
    vi.mocked(confirmDialog).mockResolvedValue(false)
    const trash = scope.run(() => useDiskTrash(ref(true)))!
    await vi.waitFor(() => expect(trash.entries.value).toEqual([file, folder]))
    await trash.empty()
    expect(diskTrashApi.purge).not.toHaveBeenCalled()
    expect(trash.entries.value).toEqual([file, folder])
  })

  it('清空只处理确认时的条目，并保留确认期间进入回收站的新文件', async () => {
    const newFile = { ...file, id: '新文件' }
    const trash = scope.run(() => useDiskTrash(ref(true)))!
    await vi.waitFor(() => expect(trash.entries.value).toEqual([file, folder]))
    vi.mocked(confirmDialog).mockImplementation(async () => {
      vi.mocked(diskTrashApi.list).mockResolvedValueOnce([file, folder, newFile]).mockResolvedValue([newFile])
      await trash.load()
      return true
    })
    await trash.empty()
    expect(vi.mocked(diskTrashApi.purge).mock.calls).toEqual([[file.id], [folder.id]])
    expect(trash.entries.value).toEqual([newFile])
  })
})
