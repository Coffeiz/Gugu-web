import { lstat, realpath, unlink } from 'node:fs/promises'
import { finishStagedLocalFile, stageLocalFile } from '@gugu/fs/node'
import path from 'node:path'
import { isPathWithin } from '../../../shared/path-safety.js'
import { normalizeFileOwnerId } from '../store.js'

async function checkedLocalFile(storageRoot: string, ownerId: string, key: string): Promise<string | null> {
  const segments = key.split('/')
  if (segments[0] !== ownerId || segments.length < 2
    || segments.some((segment) => !segment || segment === '.' || segment === '..'
      || segment.includes('\\') || segment.includes('\0')))
    throw new Error('invalid local file key')
  const root = await realpath(storageRoot)
  let current = root
  for (const segment of segments) {
    current = path.join(current, segment)
    if (!isPathWithin(root, current)) throw new Error('local file path escaped storage root')
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error('local file path traverses symlink')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return null
      throw error
    }
  }
  return current
}

export async function removeLocalFile(storageRoot: string, ownerId: string, key: string, remove: typeof unlink = unlink): Promise<boolean> {
  const current = await checkedLocalFile(storageRoot, ownerId, key)
  if (current === null) return true
  try { await remove(current) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return true
}

/** 提交前暂存待清理文件；失败时由调用方按相反顺序恢复。 */
function ownerScopedLocalPath(storageRoot: string, ownerId: string, key: string): { root: string; relative: string } {
  const owner = normalizeFileOwnerId(ownerId)
  const segments = key.split('/')
  if (segments[0] !== owner || segments.length < 2 || segments.some(segment =>
    !segment || segment === '.' || segment === '..' || segment.includes('\\') || segment.includes('\0')))
    throw new Error('invalid local file key')
  // 将 owner 目录作为相对路径的一部分传入文件系统适配器，由其从存储根逐层以
  // O_NOFOLLOW 打开目录句柄；不能先校验 ownerRoot 再按可替换路径暂存。
  return { root: storageRoot, relative: segments.join('/') }
}

export async function stageLocalFileRemoval(storageRoot: string, ownerId: string, key: string, journalId: string): Promise<{
  size: number
  stagedPath: string
  restore(): Promise<void>
  discard(): Promise<void>
} | null> {
  const target = ownerScopedLocalPath(storageRoot, ownerId, key)
  const staged = await stageLocalFile(target.root, target.relative, journalId)
  if (!staged) return null
  return {
    ...staged,
    restore: () => finishStagedLocalFile(target.root, target.relative, journalId, true),
    discard: () => finishStagedLocalFile(target.root, target.relative, journalId, false),
  }
}

/** 仅恢复日志中声明的文件；目标存在时 link 会拒绝覆盖。 */
export async function recoverStagedLocalFile(storageRoot: string, ownerId: string, key: string, journalId: string, restore: boolean): Promise<void> {
  const target = ownerScopedLocalPath(storageRoot, ownerId, key)
  await finishStagedLocalFile(target.root, target.relative, journalId, restore)
}
