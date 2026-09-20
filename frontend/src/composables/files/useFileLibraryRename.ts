import { nextTick, ref } from 'vue'
import type { FileMeta, FolderMeta } from '@/stores/filesCache'
import type { RequestMeta } from '@/services/api'
import { InteractionSync } from '@/interaction/sync/InteractionSync'
import { normalizeEditableExtension } from '@/utils/fileTypes'
import { useInlineFileRenameState } from './useInlineFileRenameState'

interface RenameOptions {
  getFile: (id: number) => FileMeta | null | undefined
  getFolder: (id: number) => FolderMeta | null | undefined
  updateFile: (id: number, patch: Partial<FileMeta>) => void
  updateFolder: (id: number, patch: Partial<FolderMeta>) => void
  renameFile: (id: number, name: string, extension?: string, meta?: RequestMeta) => void | Promise<unknown>
  renameFolder: (id: number, name: string, version: number, meta?: RequestMeta) => Promise<{ version: number }>
  reload: () => void
  onError?: (scope: 'file' | 'folder', error: unknown) => void
  onInvalidExtension?: () => void
}

async function commitFileRename(input: {
  options: RenameOptions
  fileId: number
  name: string
  rawExtension: string
  closeEditor: () => void
}) {
  const { options, fileId, name, rawExtension, closeEditor } = input
  const previous = options.getFile(fileId)
  const normalizedExtension = normalizeEditableExtension(rawExtension)
  if (normalizedExtension == null || (!normalizedExtension && previous?.ext.toUpperCase() !== 'FILE')) {
    options.onInvalidExtension?.()
    nextTick(() => document.querySelector<HTMLInputElement>('.rename-file-extension-input')?.focus())
    return
  }

  const extension = normalizedExtension || undefined
  const nextExtension = extension ?? previous?.ext ?? 'FILE'
  if (previous && previous.displayName === name && previous.ext === nextExtension) {
    closeEditor()
    return
  }

  closeEditor()
  try {
    await InteractionSync.execute({
      scope: 'file.rename', entityKey: `file:${fileId}`,
      apply: () => { options.updateFile(fileId, { displayName: name, ext: nextExtension }); options.reload() },
      rollback: () => {
        if (previous) options.updateFile(fileId, { displayName: previous.displayName, ext: previous.ext })
        options.reload()
      },
      request: mutation => Promise.resolve(options.renameFile(fileId, name, extension, { mutationId: mutation.mutationId })),
    })
  } catch (error) {
    options.onError?.('file', error)
  }
}

async function commitFolderRename(input: { options: RenameOptions; folderId: number; name: string }) {
  const { options, folderId, name } = input
  const folder = options.getFolder(folderId)
  const oldName = folder?.name
  const version = folder?.version ?? 1
  try {
    await InteractionSync.execute({
      scope: 'folder.rename', entityKey: `folder:${folderId}`,
      apply: () => { options.updateFolder(folderId, { name }); options.reload() },
      rollback: () => { if (oldName != null) options.updateFolder(folderId, { name: oldName }); options.reload() },
      request: mutation => options.renameFolder(folderId, name, version, { mutationId: mutation.mutationId }),
      onCommit: updated => options.updateFolder(folderId, { version: updated.version }),
    })
  } catch (error) {
    options.onError?.('folder', error)
  }
}

/** 文件库文件/文件夹内联重命名状态与乐观更新。页面只注入缓存和 API。 */
export function useFileLibraryRename(options: RenameOptions) {
  const fileRename = useInlineFileRenameState()
  const { renamingFileId, renameText, renameExtension } = fileRename
  const renamingFolderKey = ref<number | null>(null)

  function startFile(file: FileMeta) {
    renamingFolderKey.value = null
    fileRename.start(file)
  }

  function startFolder(folder: { folderId?: number | null; displayName: string }) {
    fileRename.cancel()
    renamingFolderKey.value = folder.folderId ?? null
    renameText.value = folder.displayName
  }

  function cancel() {
    fileRename.cancel()
    renamingFolderKey.value = null
  }

  async function commit() {
    const fileId = renamingFileId.value
    const folderId = renamingFolderKey.value
    const name = renameText.value.trim()
    if (!name || (fileId == null && folderId == null)) { cancel(); return }

    if (fileId != null) {
      await commitFileRename({ options, fileId, name, rawExtension: renameExtension.value, closeEditor: cancel })
      return
    }

    cancel()
    await commitFolderRename({ options, folderId: folderId as number, name })
  }

  return { renamingFileId, renamingFolderKey, renameText, renameExtension, startFile, startFolder, cancel, commit }
}
