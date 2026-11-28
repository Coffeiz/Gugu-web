import type { PathFileRef } from '@/services/api'

export function decodeMindFileReference(id: string | number): PathFileRef | null {
  if (typeof id !== 'string' || !/^path-[A-Za-z0-9_-]{1,24000}$/.test(id)) return null
  try {
    const binary = atob(id.slice(5).replace(/-/g, '+').replace(/_/g, '/'))
    const { directoryId, relativePath, identity, kind } = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, value => value.charCodeAt(0))))
    if (!(Number.isSafeInteger(directoryId) && directoryId > 0) && directoryId !== 'personal'
      && !(typeof directoryId === 'string' && /^(?:project:[1-9]\d*|desktop:[a-f0-9-]{36})$/.test(directoryId))) return null
    if (typeof relativePath !== 'string' || (!relativePath && kind !== 'folder') || relativePath.length > 4096) return null
    if (typeof identity !== 'string' || !/^\d{1,32}\.-?\d{1,32}\.\d{1,32}$/.test(identity)) return null
    return { directoryId, relativePath, identity }
  } catch {
    return null
  }
}

export function isMindFileReference(id: unknown): id is string {
  return typeof id === 'string' && /^(path|drop)-[A-Za-z0-9_-]{1,24000}$/u.test(id)
}

export function folderLinkReference(href: string): string | undefined {
  return /^gugu:\/\/open-object\/folder\/(path-[A-Za-z0-9_-]{1,24000})$/iu.exec(href)?.[1]
}
