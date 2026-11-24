import { effectScope, ref } from 'vue'
import { expect, it, vi } from 'vitest'
import { confirmFileDeletion } from '@/composables/files/useFileDeleteConfirm'
import { usePathFileSelection } from '@/composables/files/usePathFileSelection'
import { pathFilesApi, type PathFileEntry, type PathFileRef } from '@/services/api'

vi.mock('@/services/api', () => ({ pathFilesApi: { move: vi.fn(), copy: vi.fn(), moveToTrash: vi.fn(), download: vi.fn(), downloadArchive: vi.fn() } }))
vi.mock('@/composables/files/useFileDeleteConfirm', () => ({ confirmFileDeletion: vi.fn() }))
vi.mock('@/composables/core/useAppToast', () => ({
  errorMessage: (error: Error) => error.message,
  showAppError: vi.fn(),
}))

function file(name: string): PathFileEntry {
  return { kind: 'file', name, relativePath: name, size: 1, mimeType: 'text/plain' }
}

it('多选文件和目录时按路径整体下载', async () => {
  const scope = effectScope()
  const entries = [file('说明.txt'), { ...file('资料'), kind: 'directory' as const }]
  const target = ref<PathFileRef>({ directoryId: 'project:7', relativePath: '' })
  const selection = scope.run(() => usePathFileSelection({
    target, container: ref(null), getEntries: () => entries, getSelectedEntries: () => entries, reload: vi.fn(),
  }))!
  const archive = vi.mocked(pathFilesApi.downloadArchive).mockClear().mockResolvedValue(undefined)
  try {
    let release!: () => void
    archive.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    const pending = selection.downloadSelected()
    expect(selection.downloading.value).toBe(true)
    await selection.downloadSelected()
    expect(archive).toHaveBeenCalledExactlyOnceWith(target.value, ['说明.txt', '资料'])
    release()
    await pending
    expect(selection.downloading.value).toBe(false)
  } finally { scope.stop() }
})

it('未提供归档下载能力时仍可逐个下载所选文件', async () => {
  const scope = effectScope()
  const entries = [file('甲.txt'), file('乙.txt')]
  const target = ref<PathFileRef>({ directoryId: 'personal', relativePath: '' })
  const selection = scope.run(() => usePathFileSelection({
    target, container: ref(null), getEntries: () => entries, getSelectedEntries: () => entries, reload: vi.fn(),
  }))!
  const access = pathFilesApi as { downloadArchive?: typeof pathFilesApi.downloadArchive }
  const original = access.downloadArchive
  access.downloadArchive = undefined
  const download = vi.mocked(pathFilesApi.download).mockClear().mockResolvedValue(undefined)
  try {
    await selection.downloadSelected()
    expect(download).toHaveBeenCalledTimes(2)
    expect(download).toHaveBeenNthCalledWith(1, { directoryId: 'personal', relativePath: '甲.txt' })
    expect(download).toHaveBeenNthCalledWith(2, { directoryId: 'personal', relativePath: '乙.txt' })
  } finally { access.downloadArchive = original; scope.stop() }
})

it('批量粘贴遇到冲突时保留失败项，并限制在原授权目录内重试', async () => {
  const scope = effectScope()
  const entries = [file('首次.txt'), file('冲突.txt')]
  const target = ref<PathFileRef>({ directoryId: 'project:7', relativePath: '' })
  const reload = vi.fn()
  const selection = scope.run(() => usePathFileSelection({
    target,
    container: ref(null),
    getEntries: () => entries,
    getSelectedEntries: () => entries.filter(entry => selection.selectedPaths.value.has(entry.relativePath)),
    reload,
  }))!
  const move = vi.mocked(pathFilesApi.move)
  move.mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error('目标已存在'))
    .mockResolvedValueOnce({ ok: true })
  try {
    entries.forEach(entry => selection.select(entry))
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
    getEntries: () => [entry],
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
    target, container: ref(null), getEntries: () => [other], getSelectedEntries: () => [other], reload,
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


it('文件与文件夹支持范围选择、全选和复制粘贴，富文本继续处理自己的快捷键', async () => {
  const scope = effectScope()
  const entries = [file('首项.txt'), { ...file('资料'), kind: 'directory' as const }, file('末项.txt')]
  const target = ref<PathFileRef>({ directoryId: 'project:7', relativePath: '' })
  const reload = vi.fn()
  const selection = scope.run(() => usePathFileSelection({
    target, container: ref(null), getEntries: () => entries,
    getSelectedEntries: () => entries.filter(entry => selection.selectedPaths.value.has(entry.relativePath)),
    reload,
  }))!
  const copy = vi.mocked(pathFilesApi.copy).mockClear().mockResolvedValue({ ok: true })
  const editor = document.createElement('div')
  editor.contentEditable = 'true'
  editor.setAttribute('contenteditable', 'true')
  const child = editor.appendChild(document.createElement('span'))
  function press(key: string, element: HTMLElement = document.body) {
    const event = new KeyboardEvent('keydown', { key, metaKey: true, cancelable: true })
    element.addEventListener('keydown', selection.handleShortcut, { once: true })
    element.dispatchEvent(event)
    return event.defaultPrevented
  }
  try {
    selection.select(entries[0])
    selection.select(entries[1], new MouseEvent('click', { shiftKey: true }))
    expect(selection.selectedPaths.value).toEqual(new Set(['首项.txt', '资料']))
    expect(press('a', child)).toBe(false)
    expect(selection.selectedPaths.value.size).toBe(2)

    expect(press('a')).toBe(true)
    expect(selection.selectedPaths.value.size).toBe(3)
    expect(press('c', child)).toBe(false)
    expect(selection.canPaste.value).toBe(false)
    expect(press('C')).toBe(true)
    target.value = { directoryId: 'project:7', relativePath: '目标' }
    expect(press('v')).toBe(true)
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce())
    expect(copy.mock.calls.map(([source, destination]) => [source.relativePath, destination])).toEqual(
      entries.map(entry => [entry.relativePath, `目标/${entry.name}`]),
    )
  } finally {
    scope.stop()
  }
})
