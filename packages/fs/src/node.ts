import { constants } from 'node:fs'
import { link, lstat, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises'
import path from 'node:path'

/** 不可信路径不能用于访问授权根之外的内容。 */
export class UnsafeLocalPathError extends Error {}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

/** 在可信授权根中打开相对路径；调用方负责校验身份并关闭返回的句柄。 */
export async function openLocalFile(rootPath: string, relativePath: string) {
  const segments = relativePath.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\\') || segment.includes('\0'))) throw new UnsafeLocalPathError()
  try {
    const root = await realpath(rootPath)
    let target = root
    for (const segment of segments) {
      target = path.resolve(target, segment)
      if (!within(root, target) || (await lstat(target)).isSymbolicLink()) throw new UnsafeLocalPathError()
    }
    const canonical = await realpath(target)
    if (!within(root, canonical)) throw new UnsafeLocalPathError()
    const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const info = await handle.stat()
      if (!info.isFile()) throw new UnsafeLocalPathError()
      return { handle, size: info.size }
    } catch (error) {
      await handle.close()
      throw error
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') return null
    throw error
  }
}

/**
 * 删除授权根内的目录树。Linux 上通过已打开目录的 /proc/self/fd 锚定每层路径，
 * 检查后的父目录即使被替换为符号链接，也不会把递归删除导向根目录之外。
 * 返回删除的普通文件数；目录、符号链接和其他文件系统节点不计数。
 */
export async function removeLocalTree(rootPath: string, relativePath: string): Promise<number> {
  const segments = relativePath.split('/')
  if (process.platform !== 'linux' || segments.some(segment =>
    !segment || segment === '.' || segment === '..' || segment.includes('\\') || segment.includes('\0')))
    throw new UnsafeLocalPathError()

  async function removeEntry(parent: string, name: string): Promise<number> {
    const entry = path.join(parent, name)
    let info
    try { info = await lstat(entry) }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return 0
      throw error
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      try { await unlink(entry) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      return info.isFile() ? 1 : 0
    }

    let child
    try { child = await open(entry, constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0)) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new UnsafeLocalPathError()
      throw error
    }
    let count = 0
    try {
      const anchoredChild = `/proc/self/fd/${child.fd}`
      for (const childName of await readdir(anchoredChild)) count += await removeEntry(anchoredChild, childName)
    } finally { await child.close() }
    await rmdir(entry)
    return count
  }

  let root
  try { root = await realpath(rootPath) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  let handle
  try { handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0)) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new UnsafeLocalPathError()
    throw error
  }
  const ancestors: Awaited<ReturnType<typeof open>>[] = []
  try {
    let parent = `/proc/self/fd/${handle.fd}`
    for (const segment of segments.slice(0, -1)) {
      const current = path.join(parent, segment)
      let next
      try { next = await open(current, constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0)) }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR') return 0
        if (code === 'ELOOP') throw new UnsafeLocalPathError()
        throw error
      }
      parent = `/proc/self/fd/${next.fd}`
      // Keep all ancestor descriptors open until traversal completes.
      ancestors.push(next)
    }
    return await removeEntry(parent, segments.at(-1)!)
  } finally {
    for (const ancestor of ancestors.reverse()) await ancestor.close()
    await handle.close()
  }
}

async function checkedFilePath(rootPath: string, relativePath: string): Promise<string | null> {
  const segments = relativePath.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\\') || segment.includes('\0')))
    throw new UnsafeLocalPathError()
  try {
    const root = await realpath(rootPath)
    let target = root
    for (const segment of segments) {
      target = path.join(target, segment)
      if (!within(root, target) || (await lstat(target)).isSymbolicLink()) throw new UnsafeLocalPathError()
    }
    return target
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw error
  }
}

/** 在授权根内暂存普通文件，目标已存在时拒绝覆盖。 */
export async function stageLocalFile(root: string, relativePath: string, journalId: string) {
  if (!/^[0-9a-f-]{36}$/.test(journalId)) throw new UnsafeLocalPathError()
  const original = await checkedFilePath(root, relativePath)
  if (!original) return null
  const info = await lstat(original)
  if (!info.isFile()) throw new UnsafeLocalPathError()
  const stagedPath = `${original}.gugu-purge-${journalId}`
  await link(original, stagedPath)
  try { await unlink(original) } catch (error) { await unlink(stagedPath).catch(() => undefined); throw error }
  return { size: info.size, stagedPath }
}

/** 恢复或删除暂存文件；原位置已有不同文件时保留两者并报错。 */
export async function finishStagedLocalFile(root: string, relativePath: string, journalId: string, restore: boolean): Promise<void> {
  if (!/^[0-9a-f-]{36}$/.test(journalId)) throw new UnsafeLocalPathError()
  const suffix = `.gugu-purge-${journalId}`
  const staged = await checkedFilePath(root, `${relativePath}${suffix}`)
  if (!staged) return
  if (!(await lstat(staged)).isFile()) throw new UnsafeLocalPathError()
  if (restore) {
    const original = staged.slice(0, -suffix.length)
    try { await link(staged, original) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const [source, target] = await Promise.all([lstat(staged), lstat(original)])
      if (!source.isFile() || !target.isFile() || source.dev !== target.dev || source.ino !== target.ino) throw error
    }
  }
  await unlink(staged)
}
