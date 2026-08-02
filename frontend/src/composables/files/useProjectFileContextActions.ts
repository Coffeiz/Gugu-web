import { ref, type Ref } from 'vue'
import type { FileMeta, FolderMeta } from '@/stores/filesCache'
import { useFilesCacheStore } from '@/stores/filesCache'
import { useClipboardStore } from '@/stores/clipboard'
import { parseFolderId } from '@/utils/folderKeys'
import { useFileContextMenu } from './useFileContextMenu'
import type { useFileActions } from './useFileActions'

type ContextType = 'file' | 'multi-file' | 'folder' | 'empty'
type ContextTarget = FileMeta | FolderMeta

export interface ProjectFileContextOptions {
  fileActions: ReturnType<typeof useFileActions>
  fileCacheStore: ReturnType<typeof useFilesCacheStore>
  clipboardStore: ReturnType<typeof useClipboardStore>
  selectedFileIds: Ref<Set<number>>
  selectedFolderIds: Ref<Set<number>>
  getFiles: () => FileMeta[]
  getFolders: () => FolderMeta[]
  getFolderStack: () => FolderMeta[]
  getProjectId: () => number | null
  getProjectName: () => string
  clearSelection: () => void
  startRenameFile: (file: FileMeta) => void
  startRenameFolder: (folder: FolderMeta) => void
  downloadFolder: (folder: FolderMeta) => void
  deleteFolder: (folder: FolderMeta) => Promise<void>
  openInfo: (file: FileMeta, x: number, y: number) => void
  showNewFolder: Ref<boolean>
}

/** 项目文件区右键菜单动作和剪贴板粘贴；菜单展示仍由 FileBrowserContextMenu 负责。 */
export function useProjectFileContextActions(options: ProjectFileContextOptions) {
  const { state, open, close } = useFileContextMenu<ContextType, ContextTarget>()
  const pasteBusy = ref(false)

  function openContext(type: 'file' | 'folder' | 'empty', target: ContextTarget | null, event: MouseEvent) {
    const isMulti = type === 'file' && target &&
      (options.selectedFileIds.value.has(target.id) || options.selectedFolderIds.value.size > 0) &&
      options.selectedFileIds.value.size + options.selectedFolderIds.value.size > 1
    open(isMulti ? 'multi-file' : type, target, event)
  }

  function currentFolderId() {
    const stack = options.getFolderStack()
    return stack.length ? stack[stack.length - 1].id : null
  }

  function info() {
    const file = state.value.target as FileMeta | null
    close()
    if (file) options.openInfo(file, state.value.x, state.value.y)
  }

  async function download() {
    const target = state.value.target as FileMeta | null
    const fileIds = state.value.type === 'multi-file'
      ? [...options.selectedFileIds.value]
      : target ? [target.id] : []
    close()
    if (fileIds.length === 1 && target) {
      await options.fileActions.downloadFile(target)
      return
    }
    const folderIds = [...options.selectedFolderIds.value]
    const stack = options.getFolderStack()
    const name = stack.length ? stack[stack.length - 1].name : options.getProjectName()
    await options.fileActions.batchDownload(fileIds, folderIds, `${name}.zip`)
  }

  function rename() {
    const file = state.value.target as FileMeta | null
    close()
    if (file) options.startRenameFile(file)
  }

  function cut() {
    const target = state.value.target
    const fileIds = state.value.type === 'multi-file'
      ? [...options.selectedFileIds.value]
      : target ? [target.id] : []
    options.clipboardStore.cut(fileIds, [])
    close()
  }

  function copy() {
    const target = state.value.target
    const fileIds = state.value.type === 'multi-file'
      ? [...new Set(options.selectedFileIds.value)]
      : target && state.value.type === 'file' ? [target.id] : []
    const folderIds = target && state.value.type === 'folder' ? [target.id] : []
    options.clipboardStore.copy(fileIds, folderIds)
    close()
  }

  async function removeFile() {
    const target = state.value.target
    const fileIds = state.value.type === 'multi-file'
      ? [...options.selectedFileIds.value]
      : target ? [target.id] : []
    close()
    await Promise.all(fileIds.map(id => options.fileActions.deleteFile(id)))
    options.fileCacheStore.removeFiles(fileIds)
    options.clearSelection()
  }

  function downloadFolder() {
    const folder = state.value.target as FolderMeta | null
    close()
    if (folder) options.downloadFolder(folder)
  }

  function renameFolder() {
    const folder = state.value.target as FolderMeta | null
    close()
    if (folder) options.startRenameFolder(folder)
  }

  function cutFolder() {
    const folder = state.value.target as FolderMeta | null
    options.clipboardStore.cut([], folder ? [folder.id] : [])
    close()
  }

  async function removeFolder() {
    const folder = state.value.target as FolderMeta | null
    close()
    if (folder) await options.deleteFolder(folder)
  }

  async function paste() {
    if (pasteBusy.value) return
    pasteBusy.value = true
    close()
    const folderId = currentFolderId()
    const projectId = options.getProjectId()
    try {
      const fileIds = [...new Set(options.clipboardStore.fileIds)]
      const folderIds = [...new Set(options.clipboardStore.folderIds
        .map(id => parseFolderId(id))
        .filter((id): id is number => id != null))]
      if (options.clipboardStore.type === 'cut') {
        const [, movedFolders] = await Promise.all([
          Promise.all(fileIds.map(id => options.fileActions.moveFile(id, folderId, projectId))),
          Promise.all(folderIds.map(id => options.fileActions.moveFolder(
            id, folderId, options.fileCacheStore.getFolder(id)?.version ?? 1, projectId,
          ))),
        ])
        fileIds.forEach(id => options.fileCacheStore.updateFile(id, { folderId, projectId }))
        movedFolders.forEach(folder => options.fileCacheStore.updateFolder(folder.id, {
          parentId: folderId, projectId, version: folder.version,
        }))
        options.clipboardStore.clear()
        await options.fileCacheStore.refresh()
      } else if (options.clipboardStore.type === 'copy') {
        const created = await Promise.all(fileIds.map(id => options.fileActions.copyFile(id, folderId, projectId)))
        created.forEach(file => { if (file) options.fileCacheStore.addFile(file) })
        const copiedFolders = await Promise.all(folderIds.map(id =>
          options.fileActions.copyFolder(id, folderId, projectId)))
        copiedFolders.forEach(folder => options.fileCacheStore.addFolder(folder))
        await options.fileCacheStore.refresh()
      }
    } catch (error) {
      console.error('[ProjectModal] 粘贴失败:', error instanceof Error ? error.message : String(error))
    } finally {
      pasteBusy.value = false
    }
  }

  function handleAction(action: string) {
    const actions: Record<string, () => unknown> = {
      info,
      download,
      rename,
      cut,
      copy,
      delete: removeFile,
      'download-folder': downloadFolder,
      'rename-folder': renameFolder,
      'cut-folder': cutFolder,
      'delete-folder': removeFolder,
      'create-folder': () => { close(); options.showNewFolder.value = true },
      paste,
    }
    actions[action]?.()
  }

  return { state, pasteBusy, openContext, paste, handleAction }
}
