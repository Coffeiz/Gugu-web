import { chmod, chown, lstat, mkdir, readdir, realpath, rename, stat } from 'node:fs/promises'
import path from 'node:path'

function keySegments(key: string): string[] {
  if (typeof key !== 'string' || key.length === 0 || key.includes('\0') || key.includes('\\') || key.startsWith('/'))
    throw new Error('项目目录前缀必须是安全相对路径')
  const segments = key.split('/')
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..'))
    throw new Error('项目目录前缀必须是安全相对路径')
  return segments
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function targetPath(root: string, key: string): string {
  const target = path.resolve(root, ...keySegments(key))
  if (!isWithin(root, target)) throw new Error('项目目录路径超出存储根目录')
  return target
}

async function assertNoSymlinkComponents(root: string, target: string): Promise<void> {
  if (!isWithin(root, target)) throw new Error('项目目录路径超出存储根目录')
  const relative = path.relative(root, target)
  if (!relative) return
  let current = root
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment)
    let info
    try {
      info = await lstat(current)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return
      throw error
    }
    if (info.isSymbolicLink()) throw new Error('项目目录路径不能经过符号链接')
    if (current !== target && !info.isDirectory()) return
  }
}

async function assertRealpathWithin(root: string, target: string): Promise<void> {
  const resolved = await realpath(target)
  if (!isWithin(root, resolved)) throw new Error('项目目录路径超出存储根目录')
}

async function assertTreeContainsNoSymlinks(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const child = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error('项目目录树不能包含符号链接')
    if (entry.isDirectory()) await assertTreeContainsNoSymlinks(child)
  }
}

async function inheritGroupAccess(target: string, directory: boolean): Promise<void> {
  try {
    const parent = await stat(path.dirname(target))
    const current = await lstat(target)
    await chown(target, current.uid, parent.gid)
    const mode = current.mode & 0o7777
    await chmod(target, mode | (directory ? 0o070 : 0o060))
  } catch {
    // Python 的 _inherit_storage_access 同样把属主/权限修复作为尽力而为步骤。
  }
}

async function applyGroupAccessToTree(directory: string): Promise<void> {
  await inheritGroupAccess(directory, true)
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const child = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error('项目目录树不能包含符号链接')
    if (entry.isDirectory()) await applyGroupAccessToTree(child)
    else await inheritGroupAccess(child, false)
  }
}

/** Rename a project directory inside a local storage root, matching LocalStorageBackend semantics. */
export async function renameLocalProjectDirectory(
  storageRoot: string,
  oldPrefix: string,
  newPrefix: string,
): Promise<void> {
  const absoluteRoot = path.resolve(storageRoot)
  // Validate both keys before checking existence so an absent source cannot hide traversal input.
  keySegments(oldPrefix)
  keySegments(newPrefix)

  let root: string
  try {
    root = await realpath(absoluteRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const oldPath = targetPath(root, oldPrefix)
  const newPath = targetPath(root, newPrefix)
  if (oldPath === newPath) return
  if (!isWithin(root, oldPath) || !isWithin(root, newPath))
    throw new Error('项目目录路径超出存储根目录')
  await assertNoSymlinkComponents(root, oldPath)
  await assertNoSymlinkComponents(root, newPath)

  let sourceInfo
  try {
    sourceInfo = await lstat(oldPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return
    throw error
  }
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink())
    throw new Error('项目目录源必须是存储根目录内的真实目录')
  await assertTreeContainsNoSymlinks(oldPath)

  const parent = path.dirname(newPath)
  await assertNoSymlinkComponents(root, parent)
  await mkdir(parent, { recursive: true })
  await assertNoSymlinkComponents(root, parent)
  await assertRealpathWithin(root, parent)
  await rename(oldPath, newPath)
  await assertNoSymlinkComponents(root, newPath)
  await assertRealpathWithin(root, newPath)
  await assertTreeContainsNoSymlinks(newPath)
  await applyGroupAccessToTree(newPath)
}

/** Host callback factory; root must be the configured local storage root. */
export function createLocalProjectDirectoryRenamer(storageRoot: string) {
  return async (ownerId: string, oldPrefix: string, newPrefix: string): Promise<void> => {
    if (keySegments(oldPrefix)[0] !== ownerId || keySegments(newPrefix)[0] !== ownerId)
      throw new Error('项目目录前缀与 owner 不匹配')
    await renameLocalProjectDirectory(storageRoot, oldPrefix, newPrefix)
  }
}
