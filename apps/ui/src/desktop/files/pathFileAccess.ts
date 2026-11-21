import type { DesktopFileDirectory } from '@gugu/core/desktop'
import { downloadPathFile, pathFilesApi, type PathFileEntry, type PathFileRef } from '@/services/api'
import type { PathFileAccess } from '@/services/pathFileAccess'
import { requestDesktopFile } from '@desktop/bridge/bridge'

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
  reference: file => isLocalFile(file)
    ? requestLocalFile({ action: 'reference', ...localTarget(file) })
    : pathFilesApi.reference(file),
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
  move: (file, destination) => isLocalFile(file)
    ? requestLocalFile({ action: 'move', ...localTarget(file), destination })
    : pathFilesApi.move(file, destination),
  copy: (file, destination) => isLocalFile(file)
    ? requestLocalFile({ action: 'copy', ...localTarget(file), destination })
    : pathFilesApi.copy(file, destination),
  moveToTrash: file => isLocalFile(file)
    ? requestLocalFile({ action: 'trash', ...localTarget(file) })
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
