import type { FileMeta, FolderMeta } from '@/stores/filesCache'

export interface FileLinkContext {
  folderId?: number | null
  projectId?: number | null
}

export type ResolvedFileLink =
  | { kind: 'file'; file: FileMeta }
  | { kind: 'folder'; folder: FolderMeta }

function decodePath(value: string): string[] | null {
  try {
    return decodeURIComponent(value)
      .split('/')
      .filter(Boolean)
      .reduce<string[]>((parts, part) => {
        if (part === '.') return parts
        if (part === '..') { parts.pop(); return parts }
        parts.push(part)
        return parts
      }, [])
  } catch {
    return null
  }
}

function normalizedName(value: string) {
  return value.normalize('NFC').toLocaleLowerCase()
}

function fileNames(file: FileMeta): string[] {
  const displayName = file.displayName ?? ''
  const ext = (file.ext ?? '').replace(/^\./, '')
  const withExt = ext && !displayName.toLowerCase().endsWith(`.${ext.toLowerCase()}`)
    ? `${displayName}.${ext}`
    : displayName
  return [displayName, withExt].map(normalizedName)
}

function folderPath(folderId: number | null | undefined, folders: FolderMeta[]) {
  const byId = new Map(folders.map(folder => [folder.id, folder]))
  const result: string[] = []
  const seen = new Set<number>()
  let current = folderId == null ? null : byId.get(folderId)
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    result.unshift(current.name)
    current = current.parentId == null ? undefined : byId.get(current.parentId)
  }
  return result.map(normalizedName)
}

/**
 * 将 Markdown 的相对链接解析成当前用户文件库中的文件或文件夹。
 * 只处理相对路径，外链、锚点和协议链接交给浏览器/上层专用协议处理。
 */
export function resolveRelativeFileLink(
  href: string,
  context: FileLinkContext,
  files: FileMeta[],
  folders: FolderMeta[],
): ResolvedFileLink | null {
  if (!href || href.startsWith('#') || href.startsWith('/') || href.startsWith('//')) return null
  if (/^[a-z][a-z\d+.-]*:/i.test(href)) return null

  const cleanHref = href.split('#', 1)[0].split('?', 1)[0]
  const parts = decodePath(cleanHref)
  if (!parts?.length) return null
  const base = folderPath(context.folderId, folders)
  const targetPath = [...base]
  for (const part of parts) {
    if (part === '.') continue
    if (part === '..') targetPath.pop()
    else targetPath.push(normalizedName(part))
  }

  const sameScope = (item: { projectId?: number | null }) =>
    (item.projectId ?? null) === (context.projectId ?? null)
  if (!targetPath.length) return null

  const file = files.find(item => {
    if (!sameScope(item)) return false
    const parentPath = folderPath(item.folderId, folders)
    return fileNames(item).some(name =>
      [...parentPath, name].join('/') === targetPath.join('/'))
  })
  if (file) return { kind: 'file', file }

  const folder = folders.find(item =>
    sameScope(item) && folderPath(item.id, folders).join('/') === targetPath.join('/'))
  return folder ? { kind: 'folder', folder } : null
}
