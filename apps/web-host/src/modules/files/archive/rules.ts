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
