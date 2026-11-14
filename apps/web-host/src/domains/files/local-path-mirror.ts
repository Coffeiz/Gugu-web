import { link, lstat, mkdir, readdir, rmdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { isPathWithin } from '../../adapters/path-safety.js'

export interface PathMirrorMove {
  readonly fromKey: string
  readonly toKey: string
}

export interface PreparedPathMirrorMutation {
  /** Apply file moves and create the destination directory skeleton. */
  apply(): Promise<void>
  /** Restore moved files and remove newly-created empty directories. */
  rollback(): Promise<void>
  /** Remove old empty directory skeleton after the database commit. */
  finalize(): Promise<void>
  readonly fileChanges?: readonly PathMirrorFileChange[]
}

export interface PathMirrorFileChange {
  fileId: number
  beforeStorageKey: string
  afterStorageKey: string
  beforeDisplayName: string
  afterDisplayName: string
}

export class PathMirrorMutationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathMirrorMutationError'
  }
}

function safeSegments(ownerId: string, key: string): string[] {
  if (!key || key.includes('\0') || key.includes('\\') || key.startsWith('/'))
    throw new PathMirrorMutationError('文件存储 key 必须是安全相对路径')
  const segments = key.split('/')
  if (segments[0] !== ownerId || segments.some((part) => !part || part === '.' || part === '..'))
    throw new PathMirrorMutationError('文件存储 key 与 owner 不匹配')
  return segments
}

async function checkedPath(root: string, ownerId: string, key: string): Promise<string> {
  await assertSafeRoot(root)
  const target = path.resolve(root, ...safeSegments(ownerId, key))
  if (!isPathWithin(root, target)) throw new PathMirrorMutationError('文件存储路径超出配置根目录')
  let current = root
  for (const segment of safeSegments(ownerId, key)) {
    current = path.join(current, segment)
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new PathMirrorMutationError('文件存储路径不能经过符号链接')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
    }
  }
  return target
}

export async function localPathMirrorEntryExists(rootPath: string, ownerId: string, key: string): Promise<boolean> {
  const target = await checkedPath(path.resolve(rootPath), ownerId, key)
  try {
    const info = await lstat(target)
    if (info.isSymbolicLink()) throw new PathMirrorMutationError('文件存储路径不能经过符号链接')
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw error
  }
}

async function assertSafeRoot(root: string): Promise<void> {
  const rootInfo = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new PathMirrorMutationError('PathMirror 根目录不存在')
    throw error
  })
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())
    throw new PathMirrorMutationError('PathMirror 根路径必须是普通目录')
}

async function ensureSafeDirectory(root: string, ownerId: string, directoryKey: string): Promise<string[]> {
  await assertSafeRoot(root)
  const segments = safeSegments(ownerId, directoryKey)
  const created: string[] = []
  let current = root
  for (const segment of segments) {
    current = path.join(current, segment)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new PathMirrorMutationError('目标目录必须是安全目录')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await mkdir(current, { mode: 0o770 })
      created.push(current)
    }
  }
  return created
}

async function removeEmpty(paths: string[]): Promise<void> {
  for (const directory of [...paths].reverse()) {
    try {
      if ((await readdir(directory)).length === 0) await rmdir(directory)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error
    }
  }
}

/**
 * Create a reversible PathMirror mutation. File moves happen before the PostgreSQL commit and can
 * be compensated if SQL commit fails; old empty directory skeletons are removed only afterwards.
 */
export function createLocalPathMirrorMutation(rootPath: string, ownerId: string, moves: PathMirrorMove[], ensureDirectoryKeys: string[], removeDirectoryKeys: string[]): PreparedPathMirrorMutation {
  const root = path.resolve(rootPath)
  const resolved = moves.map(async (move) => ({
    from: await checkedPath(root, ownerId, move.fromKey),
    to: await checkedPath(root, ownerId, move.toKey),
  }))
  let files: Array<{ from: string; to: string }> = []
  let createdDirectories: string[] = []
  let movedCount = 0
  let pendingLink: { from: string; to: string } | null = null
  return {
    async apply() {
      await assertSafeRoot(root)
      files = await Promise.all(resolved)
      for (const move of files) {
        try {
          const info = await lstat(move.from)
          if (info.isSymbolicLink() || !info.isFile()) throw new PathMirrorMutationError('源文件必须是普通文件')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          throw new PathMirrorMutationError('待搬迁文件不存在')
        }
        try {
          await lstat(move.to)
          throw new PathMirrorMutationError('目标文件已存在')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      for (const key of ensureDirectoryKeys) {
        createdDirectories.push(...await ensureSafeDirectory(root, ownerId, key))
      }
      for (const move of files) {
        const parentCreated = await ensureSafeDirectory(root, ownerId, path.relative(root, path.dirname(move.to)).split(path.sep).join('/'))
        createdDirectories.push(...parentCreated)
        await link(move.from, move.to)
        pendingLink = move
        await unlink(move.from)
        pendingLink = null
        movedCount += 1
      }
    },
    async rollback() {
      if (pendingLink) {
        const [source, target] = await Promise.all([lstat(pendingLink.from), lstat(pendingLink.to)])
        if (source.dev !== target.dev || source.ino !== target.ino)
          throw new PathMirrorMutationError('回滚时源与目标已不再指向同一文件')
        await unlink(pendingLink.to)
        pendingLink = null
      }
      for (const move of [...files.slice(0, movedCount)].reverse()) {
        const relativeParent = path.relative(root, path.dirname(move.from)).split(path.sep).join('/')
        await ensureSafeDirectory(root, ownerId, relativeParent)
        await link(move.to, move.from)
        await unlink(move.to)
      }
      movedCount = 0
      await removeEmpty(createdDirectories)
      createdDirectories = []
    },
    async finalize() {
      const oldDirectories = await Promise.all(removeDirectoryKeys.map((key) => checkedPath(root, ownerId, key)))
      oldDirectories.sort((left, right) => left.split(path.sep).length - right.split(path.sep).length)
      await removeEmpty(oldDirectories)
      createdDirectories = []
    },
  }
}
