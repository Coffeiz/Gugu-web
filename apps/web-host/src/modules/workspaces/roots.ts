import { CoreError } from '@gugu/core'
import { normalizeOwnerId } from '../../shared/owner-context.js'

export function workspaceDirectoryStorageKey(rawOwnerId: string, name: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new CoreError('not_found', '工作区不存在')
  return `${normalizeOwnerId(rawOwnerId)}/workspace/${name}`
}

export function personalFileStorageKey(rawOwnerId: string): string {
  return `${normalizeOwnerId(rawOwnerId)}/个人文件`
}

export function sandboxTarget(key: string): string {
  const [, space, ...tail] = key.split('/')
  const target = space === '项目文件' ? 'project' : space === '个人文件' ? 'personal' : space === 'workspace' ? 'workspace' : null
  if (!target) throw new Error('工作区来源不属于可挂载的文件空间')
  return '/' + [target, ...tail].join('/')
}
