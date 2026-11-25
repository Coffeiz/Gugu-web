import type { DesktopFileDirectory } from '@gugu/core/desktop'
import { resolveRelativeReferences } from '@gugu/core/files/relative-references'
import { downloadPathFile, pathFilesApi, type PathFileEntry, type PathFileRef } from '@/services/api'
import type { PathFileAccess } from '@/services/pathFileAccess'
import { callDesktopBridge, requestDesktopFile } from '@desktop/bridge/bridge'
import { previewWindowBridge } from './previewWindowBridge'

type LocalFileRef = PathFileRef & { directoryId: DesktopFileDirectory }

function localTarget(file: LocalFileRef) {
  return { directoryId: file.directoryId, path: file.relativePath }
}

function isLocalFile(file: PathFileRef): file is LocalFileRef {
  return typeof file.directoryId === 'string'
}

function contentUrl(file: LocalFileRef, download = false) {
  const params = new URLSearchParams(localTarget(file))
  if (file.identity) params.set('identity', file.identity)
  if (download) params.set('download', '1')
  const origin = 'guguDesktop' in window ? 'gugu-desktop://app' : ''
  return `${origin}/__local-files/content?${params}`
}

function requestLocalFile<T>(request: Parameters<typeof requestDesktopFile>[0]) {
  return requestDesktopFile(request) as Promise<T>
}

export const desktopPathFileAccess: PathFileAccess = {
  watchDirectoryUrl: file => isLocalFile(file) ? contentUrl(file) + '&watch=1' : pathFilesApi.watchDirectoryUrl(file),
  async fileRevision(file, signal) {
    if (!isLocalFile(file)) return pathFilesApi.fileRevision(file, signal)
    const response = await fetch(contentUrl(file) + '&metadata=1', { signal, cache: 'no-store' })
    if (!response.ok) return
    const { revision } = await response.json()
    if (typeof revision === 'string') return revision
  },
  openRelativePreview(href) {
    if (!previewWindowBridge || new URLSearchParams(window.location.search).get('filePreview') !== '1') return
    return previewWindowBridge.open({ relativeHref: href }).then(reply => {
      if (reply.ok === false) throw new Error(reply.error.message)
    })
  },
  async resolveRelative(file, paths) {
    if (!isLocalFile(file)) return pathFilesApi.resolveRelative(file, paths)
    await requestLocalFile({ action: 'reference', ...localTarget(file), kind: 'file', identity: file.identity })
    const lookup = async (parts: readonly string[], name: string, kind: 'file' | 'directory') => {
      const entries = await requestLocalFile<PathFileEntry[]>({ action: 'list', directoryId: file.directoryId, path: parts.join('/') })
      const entry = entries.find(item => item.name === name && item.kind === kind)
      return entry ? { relativePath: entry.relativePath, name: entry.name } : null
    }
    return resolveRelativeReferences(file.relativePath.split('/').slice(0, -1), paths, {
      fileAt: (parts, name) => lookup(parts, name, 'file'),
      folderAt: (parts, name) => lookup(parts, name, 'directory'),
    })
  },
  reference: (file, kind = 'file') => isLocalFile(file)
    ? requestLocalFile({ action: 'reference', ...localTarget(file), kind, identity: file.identity })
    : pathFilesApi.reference(file, kind),
  entries: (directoryId, relativePath = '') => typeof directoryId === 'string'
    ? requestLocalFile<PathFileEntry[]>({ action: 'list', directoryId, path: relativePath })
    : pathFilesApi.entries(directoryId, relativePath),
  contentUrl: (file, download = false) => isLocalFile(file)
    ? contentUrl(file, download)
    : pathFilesApi.contentUrl(file, download),
  thumbnailUrl: file => isLocalFile(file)
    ? contentUrl(file) + '&thumbnail=1'
    : pathFilesApi.thumbnailUrl(file),
  systemReferenceUrl: (reference, thumbnail) => {
    const params = new URLSearchParams({ reference })
    if (thumbnail) params.set('thumbnail', '1')
    const origin = 'guguDesktop' in window ? 'gugu-desktop://app' : ''
    return `${origin}/__local-files/content?${params}`
  },
  createFolder: file => isLocalFile(file)
    ? requestLocalFile({ action: 'mkdir', ...localTarget(file) })
    : pathFilesApi.createFolder(file),
  moveDropped(directoryId, relativePath, decide, progress) {
    if (typeof directoryId !== 'string' || !('guguDesktop' in window)) return
    return callDesktopBridge(bridge => {
      if (!bridge.moveDroppedFiles) throw new Error('请更新并重启咕咕后再拖入文件')
      return bridge.moveDroppedFiles(directoryId as DesktopFileDirectory, relativePath, decide, progress)
    })
  },
  hasHistory: (directory, mode) => typeof directory === 'string' || pathFilesApi.hasHistory(directory, mode),
  applyHistory: (directory, mode) => typeof directory === 'string'
    ? requestLocalFile({ action: mode === 'undo' ? 'undo-trash' : 'redo-trash', directoryId: directory })
    : pathFilesApi.applyHistory(directory, mode),
  move: (file, destination) => isLocalFile(file)
    ? requestLocalFile({ action: 'move', ...localTarget(file), destination })
    : pathFilesApi.move(file, destination),
  copy: (file, destination) => isLocalFile(file)
    ? requestLocalFile({ action: 'copy', ...localTarget(file), destination })
    : pathFilesApi.copy(file, destination),
  moveToTrash: file => isLocalFile(file)
    ? requestLocalFile({ action: 'trash', ...localTarget(file), undoable: true })
    : pathFilesApi.moveToTrash(file),
  async upload(file, content, onProgress, overwrite = false) {
    if (!isLocalFile(file)) return pathFilesApi.upload(file, content, onProgress, overwrite)
    if (content.size > 32 * 1024 * 1024) throw new Error('单个文件最大支持 32 MB')
    const data = new Uint8Array(await content.arrayBuffer())
    const result = await requestLocalFile({ action: 'upload', ...localTarget(file), data, overwrite })
    onProgress(100)
    return result
  },
  saveText: (file, content) => isLocalFile(file)
    ? requestLocalFile({
        action: 'upload', ...localTarget(file), data: new TextEncoder().encode(content),
        overwrite: true, identity: file.identity,
      })
    : pathFilesApi.saveText(file, content),
  async download(file) {
    if (!isLocalFile(file)) return pathFilesApi.download(file)
    if ('guguDesktop' in window) return requestLocalFile({ action: 'download', ...localTarget(file), identity: file.identity })
    downloadPathFile(file, contentUrl(file, true))
  },
}
