import { CoreError } from '@gugu/core'
import { lookup as lookupMimeType } from 'mime-types'

export const MAX_COMPRESS_SOURCE_BYTES = 512 * 1024 * 1024
export const MAX_EXTRACT_BYTES = 2 * 1024 * 1024 * 1024
export const MAX_ARCHIVE_ENTRIES = 10_000

export function safeArchivePath(rawName: string): string {
  if (rawName.includes('\0')) throw new CoreError('invalid_request', '压缩包损坏')
  const normalized = rawName.replaceAll('\\', '/')
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized))
    throw new CoreError('invalid_request', '压缩包损坏')
  const parts = normalized.split('/')
  if (parts.some((part) => part === '..')) throw new CoreError('invalid_request', '压缩包损坏')
  const result = parts.filter((part) => part && part !== '.').join('/')
  if (result.startsWith('/') || /^[a-zA-Z]:/.test(result))
    throw new CoreError('invalid_request', '压缩包损坏')
  return result
}

export function splitArchiveFilename(name: string): { displayName: string; ext: string } {
  const index = name.lastIndexOf('.')
  if (index <= 0) return { displayName: name, ext: '' }
  return { displayName: name.slice(0, index), ext: name.slice(index + 1).toLowerCase() }
}

export function nextArchiveName(name: string, occupied: Set<string>, directory = false): string {
  if (!occupied.has(name)) {
    occupied.add(name)
    return name
  }
  const { displayName, ext } = directory ? { displayName: name, ext: '' } : splitArchiveFilename(name)
  let index = 2
  let candidate = ''
  do {
    candidate = `${displayName} (${index})${ext ? `.${ext}` : ''}`
    index += 1
  } while (occupied.has(candidate))
  occupied.add(candidate)
  return candidate
}

export function supportedArchiveFormat(filename: string, extension: string): 'zip' | 'tar' | null {
  const value = `${filename}.${extension}`.toLowerCase()
  if (value.endsWith('.zip')) return 'zip'
  if (value.endsWith('.tar') || value.endsWith('.tar.gz') || value.endsWith('.tgz')) return 'tar'
  return null
}

export function archiveMimeType(filename: string): string {
  return lookupMimeType(filename) || 'application/octet-stream'
}

export type FolderArchiveTreeRecord = {
  id: number | string
  parent_id: number | string | null
  root_id: number | string
  name: string
}

export type FolderArchiveFileRecord = {
  id: number | string
  folder_id: number | string
  display_name: string
  ext: string
  size_bytes: number | string
  storage_key: string
}

function safeArchiveEntryName(value: string): string {
  const result = value.replace(/[\\/:*?"<>|\0]/g, '_')
  if (!result || result === '.' || result === '..') throw new CoreError('invalid_request', '文件名称无效')
  return result
}

/** 构造所选文件夹的 ZIP 项，并按每层目录单独解决同名文件/目录冲突。 */
export function buildFolderArchiveEntries<
  TFolder extends FolderArchiveTreeRecord,
  TFile extends FolderArchiveFileRecord,
>(
  treeRows: TFolder[],
  containedFiles: TFile[],
  rootNames = new Set<string>(),
): Array<{ archivePath: string; kind: 'file' | 'folder'; row?: TFolder | TFile }> {
  const entries: Array<{ archivePath: string; kind: 'file' | 'folder'; row?: TFolder | TFile }> = []
  const childrenByParent = new Map<number | null, TFolder[]>()
  for (const folder of treeRows) {
    const parent = Number(folder.id) === Number(folder.root_id)
      ? null
      : folder.parent_id == null ? null : Number(folder.parent_id)
    const children = childrenByParent.get(parent) ?? []
    children.push(folder)
    childrenByParent.set(parent, children)
  }
  const filesByFolder = new Map<number, TFile[]>()
  for (const file of containedFiles) {
    const folderId = Number(file.folder_id)
    const children = filesByFolder.get(folderId) ?? []
    children.push(file)
    filesByFolder.set(folderId, children)
  }
  const walk = (folder: TFolder, archiveParent: string, occupied: Set<string>): void => {
    const folderName = nextArchiveName(safeArchiveEntryName(String(folder.name)), occupied, true)
    const archivePath = archiveParent ? `${archiveParent}/${folderName}` : folderName
    entries.push({ archivePath: `${archivePath}/`, kind: 'folder', row: folder })
    const childNames = new Set<string>()
    for (const child of childrenByParent.get(Number(folder.id)) ?? []) walk(child, archivePath, childNames)
    for (const file of filesByFolder.get(Number(folder.id)) ?? []) {
      const fileName = safeArchiveEntryName(`${file.display_name}${file.ext ? `.${file.ext}` : ''}`)
      entries.push({ archivePath: `${archivePath}/${nextArchiveName(fileName, childNames)}`, kind: 'file', row: file })
    }
  }
  for (const root of childrenByParent.get(null) ?? []) walk(root, '', rootNames)
  return entries
}
