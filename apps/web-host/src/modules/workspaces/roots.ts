import { CoreError } from '@gugu/core'
import { normalizeOwnerId } from '../../shared/owner-context.js'

export function workspaceDirectoryStorageKey(rawOwnerId: string, name: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new CoreError('not_found', '工作区不存在')
  return `${normalizeOwnerId(rawOwnerId)}/workspace/${name}`
}

export function personalFileStorageKey(rawOwnerId: string): string {
  return `${normalizeOwnerId(rawOwnerId)}/个人文件`
}
