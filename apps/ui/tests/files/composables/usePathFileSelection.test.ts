import { effectScope, ref } from 'vue'
import { expect, it, vi } from 'vitest'
import { confirmFileDeletion } from '@/composables/files/useFileDeleteConfirm'
import { usePathFileSelection } from '@/composables/files/usePathFileSelection'
import { pathFilesApi, type PathFileEntry, type PathFileRef } from '@/services/api'

vi.mock('@/services/api', () => ({ pathFilesApi: { move: vi.fn(), moveToTrash: vi.fn() } }))
vi.mock('@/composables/files/useFileDeleteConfirm', () => ({ confirmFileDeletion: vi.fn() }))
vi.mock('@/composables/core/useAppToast', () => ({
  errorMessage: (error: Error) => error.message,
  showAppError: vi.fn(),
}))

function file(name: string): PathFileEntry {
  return { kind: 'file', name, relativePath: name, size: 1, mimeType: 'text/plain' }
}

it('批量粘贴遇到冲突时保留失败项，并限制在原授权目录内重试', async () => {
  const scope = effectScope()
  const entries = [file('首次.txt'), file('冲突.txt')]
  const target = ref<PathFileRef>({ directoryId: 'project:7', relativePath: '' })
  const reload = vi.fn()
  const selection = scope.run(() => usePathFileSelection({
    target,
    container: ref(null),
    getSelectedEntries: () => entries.filter(entry => selection.selectedPaths.value.has(entry.relativePath)),
    reload,
  }))!
  const move = vi.mocked(pathFilesApi.move)
  move.mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error('目标已存在'))
    .mockResolvedValueOnce({ ok: true })
  try {
    entries.forEach(selection.select)
    selection.cutSelected()
    expect(selection.fileCount.value).toBe(0)

    target.value = { directoryId: 'project:8', relativePath: '目标' }
    await selection.paste()
    expect(move).not.toHaveBeenCalled()

    target.value = { directoryId: 'project:7', relativePath: '目标' }
    await selection.paste()
    expect(selection.cutPaths.value).toEqual(new Set(['冲突.txt']))
    expect(reload).toHaveBeenCalledTimes(1)

    await selection.paste()
    expect(move.mock.calls.map(([source, destination]) => [source.relativePath, destination])).toEqual([
      ['首次.txt', '目标/首次.txt'], ['冲突.txt', '目标/冲突.txt'], ['冲突.txt', '目标/冲突.txt'],
    ])
    expect(selection.canPaste.value).toBe(false)
  } finally {
    scope.stop()
  }
})

it('取消移到回收站时保留选中状态且不发请求', async () => {
  const scope = effectScope()
  const entry = file('样本.txt')
  const selection = scope.run(() => usePathFileSelection({
    target: ref<PathFileRef>({ directoryId: 'personal', relativePath: '' }),
    container: ref(null),
    getSelectedEntries: () => [entry],
    reload: vi.fn(),
  }))!
  vi.mocked(confirmFileDeletion).mockResolvedValue(false)
  try {
    selection.select(entry)
    await selection.trashSelected()
    expect(selection.selectedPaths.value.has(entry.relativePath)).toBe(true)
    expect(pathFilesApi.moveToTrash).not.toHaveBeenCalled()
  } finally {
    scope.stop()
  }
})

it('文件夹卡片确认后仅删除当前项目的目标，取消文件删除时不发请求', async () => {
  const scope = effectScope()
  const folder: PathFileEntry = { ...file('资料'), kind: 'directory' }
  const other = file('保留.txt')
  const target = ref<PathFileRef>({ directoryId: 'project:7', relativePath: '' })
  const reload = vi.fn()
  const selection = scope.run(() => usePathFileSelection({
    target, container: ref(null), getSelectedEntries: () => [other], reload,
  }))!
  const confirm = vi.mocked(confirmFileDeletion)
  const trash = vi.mocked(pathFilesApi.moveToTrash)
  confirm.mockClear().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
  trash.mockClear().mockResolvedValue({ ok: true })
  try {
    await selection.trashEntry(other)
    expect(confirm).toHaveBeenNthCalledWith(1, 'file', { name: other.name })
    expect(trash).not.toHaveBeenCalled()
    await selection.trashEntry(folder)
    expect(confirm).toHaveBeenNthCalledWith(2, 'folder', { name: folder.name })
    expect(trash).toHaveBeenCalledExactlyOnceWith({ directoryId: 'project:7', relativePath: folder.relativePath })
    expect(reload).toHaveBeenCalledOnce()
  } finally {
    scope.stop()
  }
})
