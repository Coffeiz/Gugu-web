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

/** 一次构建、多次查询的路径索引：folderId → 归一化路径，归一化路径 → 文件/文件夹。 */
interface FileLinkLookup {
  resolve(href: string, context: FileLinkContext): ResolvedFileLink | null
}

function buildFileLinkLookup(files: FileMeta[], folders: FolderMeta[]): FileLinkLookup {
  const folderPaths = new Map<number, string[]>()
  const pathOf = (folderId: number | null | undefined): string[] => {
    if (folderId == null) return []
    const cached = folderPaths.get(folderId)
    if (cached) return cached
    const byId = new Map(folders.map(folder => [folder.id, folder]))
    const result: string[] = []
    const seen = new Set<number>()
    let current = byId.get(folderId)
    while (current && !seen.has(current.id)) {
      seen.add(current.id)
      result.unshift(current.name)
      current = current.parentId == null ? undefined : byId.get(current.parentId)
    }
    const normalized = result.map(normalizedName)
    folderPaths.set(folderId, normalized)
    return normalized
  }

  const fileByPath = new Map<string, FileMeta>()
  for (const file of files) {
    const parentPath = pathOf(file.folderId)
    for (const name of fileNames(file)) {
      // 同名冲突保持首见优先（与旧 Array.find 语义一致）
      const key = [...parentPath, name].join('/')
      if (!fileByPath.has(key)) fileByPath.set(key, file)
    }
  }
  const folderByPath = new Map<string, FolderMeta>()
  for (const folder of folders) {
    const key = pathOf(folder.id).join('/')
    if (!folderByPath.has(key)) folderByPath.set(key, folder)
  }

  return {
    resolve(href, context) {
      if (!href || href.startsWith('#') || href.startsWith('/') || href.startsWith('//')) return null
      if (/^[a-z][a-z\d+.-]*:/i.test(href)) return null

      const cleanHref = href.split('#', 1)[0].split('?', 1)[0]
      const parts = decodePath(cleanHref)
      if (!parts?.length) return null
      const targetPath = [...pathOf(context.folderId)]
      for (const part of parts) {
        if (part === '.') continue
        if (part === '..') targetPath.pop()
        else targetPath.push(normalizedName(part))
      }
      if (!targetPath.length) return null

      const targetKey = targetPath.join('/')
      const sameScope = (item: { projectId?: number | null }) =>
        (item.projectId ?? null) === (context.projectId ?? null)

      const file = fileByPath.get(targetKey)
      if (file && sameScope(file)) return { kind: 'file', file }

      const folder = folderByPath.get(targetKey)
      return folder && sameScope(folder) ? { kind: 'folder', folder } : null
    },
  }
}

/**
 * 将 Markdown 的相对链接解析成当前用户文件库中的文件或文件夹。
 * 只处理相对路径，外链、锚点和协议链接交给浏览器/上层专用协议处理。
 *
 * 单次调用场景用本函数；同一份文件列表上要解析多个链接（如整篇 md 的图片）时，
 * 用 buildFileLinkIndex 建一次索引反复查询——旧实现每个链接都对全量文件重算
 * 目录路径，大文件库 × 多图时整篇解析会拖到秒级。
 */
export function resolveRelativeFileLink(
  href: string,
  context: FileLinkContext,
  files: FileMeta[],
  folders: FolderMeta[],
): ResolvedFileLink | null {
  return buildFileLinkLookup(files, folders).resolve(href, context)
}

/** 同 resolveRelativeFileLink，但共享一次构建的路径索引；供多篇/多链接批量解析复用。 */
export function buildFileLinkIndex(files: FileMeta[], folders: FolderMeta[]): FileLinkLookup {
  return buildFileLinkLookup(files, folders)
}
