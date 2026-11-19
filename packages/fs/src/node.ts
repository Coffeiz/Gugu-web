import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from 'node:fs/promises'
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

/** 在授权根内原子替换普通文件；目录遍历锚定已打开的 Linux 目录句柄。 */
export function writeLocalFile(rootPath: string, relativePath: string, content: string | Uint8Array): Promise<void> {
  return publishLocalFile(rootPath, relativePath, content, { replace: true })
}

/** 完整接收并同步文件后才发布；目录已存在，且并发写入同名目标时拒绝覆盖。 */
export function importLocalFile(
  rootPath: string, relativePath: string, content: AsyncIterable<Uint8Array>, signal: AbortSignal,
): Promise<void> {
  return publishLocalFile(rootPath, relativePath, content, { replace: false, signal })
}

/** 在授权根内流式创建新文件，并通过已打开的目录句柄安全创建缺失父目录。 */
export function writeLocalFileStream(
  rootPath: string, relativePath: string, content: AsyncIterable<Uint8Array>, signal: AbortSignal,
): Promise<void> {
  return publishLocalFile(rootPath, relativePath, content, { replace: false, createParents: true, signal })
}

async function publishLocalFile(
  rootPath: string, relativePath: string, content: string | Uint8Array | AsyncIterable<Uint8Array>,
  options: { replace: boolean; createParents?: boolean; signal?: AbortSignal },
): Promise<void> {
  options.signal?.throwIfAborted()
  const segments = relativePath.split('/')
  if (process.platform !== 'linux' || (options.replace || options.createParents) && segments.length < 2 || segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\\') || segment.includes('\0')))
    throw new UnsafeLocalPathError()

  const root = await realpath(rootPath)
  const rootHandle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0))
  const parents: Awaited<ReturnType<typeof open>>[] = []
  let parent = `/proc/self/fd/${rootHandle.fd}`
  let temporaryPath: string | undefined
  try {
    for (const segment of segments.slice(0, -1)) {
      const nextPath = `${parent}/${segment}`
      let next
      try { next = await open(nextPath, constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0)) }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ELOOP' || code === 'ENOTDIR') throw new UnsafeLocalPathError()
        if (code !== 'ENOENT' || !options.replace && !options.createParents) throw error
        try { await mkdir(nextPath, { mode: 0o700 }) }
        catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError }
        try { next = await open(nextPath, constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0)) }
        catch (openError) {
          const openCode = (openError as NodeJS.ErrnoException).code
          if (openCode === 'ELOOP' || openCode === 'ENOTDIR') throw new UnsafeLocalPathError()
          throw openError
        }
      }
      parents.push(next)
      parent = `/proc/self/fd/${next.fd}`
    }

    const name = segments.at(-1)!
    const targetPath = `${parent}/${name}`
    if (options.replace) {
      try {
        if ((await lstat(targetPath)).isSymbolicLink()) throw new UnsafeLocalPathError()
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    const staged = `${parent}/.gugu-write-${randomUUID()}`
    const file = await open(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    temporaryPath = staged
    try {
      await file.writeFile(content, { signal: options.signal })
      options.signal?.throwIfAborted()
      await file.sync()
    } finally { await file.close() }
    options.signal?.throwIfAborted()
    if (options.replace) await rename(staged, targetPath)
    else {
      await link(staged, targetPath)
      await unlink(staged)
    }
    temporaryPath = undefined
    await (parents.at(-1) ?? rootHandle).sync()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') throw new UnsafeLocalPathError()
    throw error
  } finally {
    if (temporaryPath) await unlink(temporaryPath).catch(() => undefined)
    for (const handle of parents.reverse()) await handle.close()
    await rootHandle.close()
  }
}

/**
 * 删除授权根内的目录树。Linux 上通过已打开目录的 /proc/self/fd 锚定每层路径，
 * 检查后的父目录即使被替换为符号链接，也不会把递归删除导向根目录之外。
 * 返回删除的普通文件数；目录、符号链接和其他文件系统节点不计数。
 */
export function removeLocalTree(rootPath: string, relativePath: string): Promise<number> {
  return removeLocalPath(rootPath, relativePath, false)
}

/** 只删除普通文件。父目录或目标类型异常时拒绝，真实缺失允许幂等清理。 */
export async function removeLocalFile(rootPath: string, relativePath: string): Promise<void> {
  await removeLocalPath(rootPath, relativePath, true)
}

async function removeLocalPath(rootPath: string, relativePath: string, fileOnly: boolean): Promise<number> {
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
      if (code === 'ENOENT' || (!fileOnly && code === 'ENOTDIR')) return 0
      throw error
    }
    if (fileOnly && !info.isFile()) throw new UnsafeLocalPathError()
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
        if (code === 'ENOENT' || (!fileOnly && code === 'ENOTDIR')) return 0
        if (code === 'ELOOP' || code === 'ENOTDIR') throw new UnsafeLocalPathError()
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

async function openAnchoredParent(rootPath: string, relativePath: string) {
  const segments = relativePath.split('/')
  if (process.platform !== 'linux' || segments.some(segment =>
    !segment || segment === '.' || segment === '..' || segment.includes('\\') || segment.includes('\0')))
    throw new UnsafeLocalPathError()
  let root: string
  try { root = await realpath(rootPath) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  let handle
  try { handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0)) }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ELOOP' || code === 'ENOTDIR') throw new UnsafeLocalPathError()
    if (code === 'ENOENT') return null
    throw error
  }
  const ancestors: Awaited<ReturnType<typeof open>>[] = []
  try {
    let parent = `/proc/self/fd/${handle.fd}`
    for (const segment of segments.slice(0, -1)) {
      let next
      try { next = await open(path.join(parent, segment), constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0)) }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT') {
          for (const ancestor of ancestors.reverse()) await ancestor.close()
          await handle.close()
          return null
        }
        if (code === 'ELOOP' || code === 'ENOTDIR') throw new UnsafeLocalPathError()
        throw error
      }
      ancestors.push(next)
      parent = `/proc/self/fd/${next.fd}`
    }
    return {
      parent,
      name: segments.at(-1)!,
      path: path.join(root, ...segments),
      close: async () => {
        for (const ancestor of ancestors.reverse()) await ancestor.close()
        await handle.close()
      },
    }
  } catch (error) {
    for (const ancestor of ancestors.reverse()) await ancestor.close()
    await handle.close()
    throw error
  }
}

/** 在授权根内暂存普通文件，目标已存在时拒绝覆盖。 */
export async function stageLocalFile(root: string, relativePath: string, journalId: string) {
  if (!/^[0-9a-f-]{36}$/.test(journalId)) throw new UnsafeLocalPathError()
  const parent = await openAnchoredParent(root, relativePath)
  if (!parent) return null
  const original = `${parent.parent}/${parent.name}`
  const staged = `${original}.gugu-purge-${journalId}`
  try {
    let info
    try { info = await lstat(original) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    if (!info.isFile() || info.isSymbolicLink()) throw new UnsafeLocalPathError()
    await link(original, staged)
    try {
      const current = await lstat(original)
      if (!current.isFile() || current.dev !== info.dev || current.ino !== info.ino) throw new UnsafeLocalPathError()
      await unlink(original)
    } catch (error) {
      await unlink(staged).catch(() => undefined)
      throw error
    }
    return { size: info.size, stagedPath: `${parent.path}.gugu-purge-${journalId}` }
  } finally { await parent.close() }
}

/** 恢复或删除暂存文件；原位置已有不同文件时保留两者并报错。 */
export async function finishStagedLocalFile(root: string, relativePath: string, journalId: string, restore: boolean): Promise<void> {
  if (!/^[0-9a-f-]{36}$/.test(journalId)) throw new UnsafeLocalPathError()
  const suffix = `.gugu-purge-${journalId}`
  const parent = await openAnchoredParent(root, relativePath)
  if (!parent) return
  const original = `${parent.parent}/${parent.name}`
  const staged = `${original}${suffix}`
  try {
    let source
    try { source = await lstat(staged) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    if (!source.isFile() || source.isSymbolicLink()) throw new UnsafeLocalPathError()
    if (restore) {
      try { await link(staged, original) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const target = await lstat(original)
        if (!target.isFile() || target.isSymbolicLink() || source.dev !== target.dev || source.ino !== target.ino) throw error
      }
    }
    await unlink(staged)
  } finally { await parent.close() }
}
