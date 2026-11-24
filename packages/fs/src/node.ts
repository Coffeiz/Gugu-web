import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { getSystemErrorName } from 'node:util'

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

/** 完整接收并同步文件后才发布；仅显式覆盖时允许替换现有普通文件。 */
export function importLocalFile(
  rootPath: string, relativePath: string, content: AsyncIterable<Uint8Array>, signal: AbortSignal, overwrite = false,
): Promise<void> {
  return publishLocalFile(rootPath, relativePath, content, { replace: overwrite, requireExisting: overwrite, signal })
}

/** 在授权根内流式创建新文件，并通过已打开的目录句柄安全创建缺失父目录。 */
export function writeLocalFileStream(
  rootPath: string, relativePath: string, content: AsyncIterable<Uint8Array>, signal: AbortSignal,
): Promise<void> {
  return publishLocalFile(rootPath, relativePath, content, { replace: false, createParents: true, signal })
}

async function publishLocalFile(
  rootPath: string, relativePath: string, content: string | Uint8Array | AsyncIterable<Uint8Array>,
  options: { replace: boolean; requireExisting?: boolean; createParents?: boolean; signal?: AbortSignal },
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
      const next = await openChildDirectory(parent, segment, (options.replace && !options.requireExisting) || options.createParents === true)
      parents.push(next)
      parent = `/proc/self/fd/${next.fd}`
    }

    const name = segments.at(-1)!
    const targetPath = `${parent}/${name}`
    const original = options.requireExisting ? await lstat(targetPath, { bigint: true }) : null
    if (original && !original.isFile()) throw new UnsafeLocalPathError()
    if (options.replace && !original) {
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
    if (original) {
      const current = await lstat(targetPath, { bigint: true })
      if (current.dev !== original.dev || current.ino !== original.ino || current.ctimeNs !== original.ctimeNs)
        throw Object.assign(new Error('覆盖目标已变化'), { code: 'EEXIST' })
    }
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

async function openChildDirectory(parent: string, name: string, create: boolean) {
  const target = path.join(parent, name)
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  try {
    return await open(target, flags)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ELOOP' || code === 'ENOTDIR') throw new UnsafeLocalPathError()
    if (code !== 'ENOENT' || !create) throw error
  }
  try {
    await mkdir(target, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  return openChildDirectory(parent, name, false)
}

async function openAnchoredParent(rootPath: string | number, relativePath: string, createParents = false) {
  const segments = relativePath.split('/')
  if (process.platform !== 'linux' || segments.some(segment =>
    !segment || segment === '.' || segment === '..' || segment.includes('\\') || segment.includes('\0')))
    throw new UnsafeLocalPathError()
  let root: string
  try { root = typeof rootPath === 'number' ? `/proc/self/fd/${rootPath}` : await realpath(rootPath) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  let handle
  try { handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | (typeof rootPath === 'number' ? 0 : constants.O_NOFOLLOW ?? 0)) }
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
      try { next = await openChildDirectory(parent, segment, createParents) }
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
      fd: (ancestors.at(-1) ?? handle).fd,
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

export async function createLocalDirectory(root: string, relativePath: string): Promise<boolean> {
  const parent = await openAnchoredParent(root, relativePath)
  if (!parent) return false
  try {
    await mkdir(path.join(parent.parent, parent.name), { mode: 0o700 })
    return true
  } finally {
    await parent.close()
  }
}

let renameFunctions: { renameat2: (from: number, source: Buffer, to: number, destination: Buffer, flags: number) => number; __errno_location: () => bigint } | undefined

/** 源和目标都相对于打开的目录句柄；内核保证移动与拒绝覆盖在同一步完成。 */
export async function moveLocalEntry(root: string, fromPath: string, toPath: string): Promise<boolean> {
  const from = await openAnchoredParent(root, fromPath)
  if (!from) return false
  try {
    const to = await openAnchoredParent(root, toPath)
    if (!to) return false
    try {
      const info = await lstat(path.join(from.parent, from.name)).catch(error => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (!info) return false
      if (!info.isFile() && !info.isDirectory()) throw new UnsafeLocalPathError()
      const ffi = await import('node:ffi')
      renameFunctions ??= ffi.dlopen(null, {
        renameat2: { arguments: ['i32', 'pointer', 'i32', 'pointer', 'u32'], return: 'i32' },
        __errno_location: { arguments: [], return: 'pointer' },
      }).functions
      const errno = renameFunctions.__errno_location()
      const RENAME_NOREPLACE = 1
      if (renameFunctions.renameat2(from.fd, Buffer.from(`${from.name}\0`), to.fd, Buffer.from(`${to.name}\0`), RENAME_NOREPLACE) === 0)
        return true
      const number = ffi.getInt32(errno)
      const code = number > 0 ? getSystemErrorName(-number) : 'UNKNOWN'
      if (code === 'ENOENT') return false
      throw Object.assign(new Error('无法移动文件或目录'), { code })
    } finally {
      await to.close()
    }
  } finally {
    await from.close()
  }
}

/** 读取用户可修改的目录树时，逐段固定目录句柄，拒绝符号链接。 */
export async function openAnchoredLocalFile(root: string | number, relativePath: string, directory = false) {
  const parent = await openAnchoredParent(root, relativePath)
  if (!parent) return null
  try {
    const handle = await open(path.join(parent.parent, parent.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (directory ? constants.O_DIRECTORY : 0))
    try {
      const info = await handle.stat()
      if (!(directory ? info.isDirectory() : info.isFile())) throw new UnsafeLocalPathError()
      return { handle, size: info.size }
    } catch (error) {
      await handle.close()
      throw error
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    if (code === 'ELOOP' || (directory && code === 'ENOTDIR')) throw new UnsafeLocalPathError()
    throw error
  } finally {
    await parent.close()
  }
}

/** 在已固定的文件句柄上取得可跨同卷重命名比较的身份。 */
export async function localFileIdentity(handle: Awaited<ReturnType<typeof open>>): Promise<string | null> {
  const info = await handle.stat({ bigint: true })
  if (info.birthtimeNs <= 0n || info.ino <= 0n) return null
  return `${info.dev}.${info.ino}.${info.birthtimeNs}`
}

export async function listLocalDirectory(root: string, relativePath: string) {
  const parent = await openAnchoredParent(root, relativePath)
  if (!parent) return null
  try {
    const handle = await open(path.join(parent.parent, parent.name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      const directory = `/proc/self/fd/${handle.fd}`
      const entries: Array<{ name: string; kind: 'directory' | 'file'; size: number }> = []
      for (const name of await readdir(directory)) {
        if (name.startsWith('.gugu-') || name.includes('\\')) continue
        const info = await lstat(path.join(directory, name)).catch(error => {
          if (error.code === 'ENOENT') return null
          throw error
        })
        if (info?.isDirectory()) entries.push({ name, kind: 'directory', size: 0 })
        if (info?.isFile()) entries.push({ name, kind: 'file', size: info.size })
      }
      return entries
    } finally {
      await handle.close()
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    if (code === 'ELOOP' || code === 'ENOTDIR') throw new UnsafeLocalPathError()
    throw error
  } finally {
    await parent.close()
  }
}

/** 宿主提供可信目录键，调用者只传相对于该目录的路径。 */
export async function localEntryKind(root: string, key: string) {
  const parent = await openAnchoredParent(root, key)
  if (!parent) return null
  try {
    const info = await lstat(path.join(parent.parent, parent.name)).catch(error => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!info) return null
    if (info.isDirectory()) return 'directory' as const
    if (info.isFile()) return 'file' as const
    throw new UnsafeLocalPathError()
  } finally {
    await parent.close()
  }
}

/** 先复制到目标目录下的暂存项，再原子发布完整文件或目录。 */
async function copyLocalEntry(root: string, source: string, destination: string, signal: AbortSignal): Promise<boolean> {
  if (source === destination || destination.startsWith(`${source}/`))
    throw Object.assign(new Error('不能复制到自身或子目录'), { code: 'EINVAL' })
  const staging = path.posix.join(path.posix.dirname(destination), `.gugu-copy-${randomUUID()}`)

  async function copy(from: string, to: string): Promise<boolean> {
    signal.throwIfAborted()
    const kind = await localEntryKind(root, from)
    if (kind === null) return false
    if (kind === 'directory') {
      if (!await createLocalDirectory(root, to)) return false
      const entries = await listLocalDirectory(root, from)
      if (!entries) return false
      for (const entry of entries) {
        if (!await copy(`${from}/${entry.name}`, `${to}/${entry.name}`)) return false
      }
      return true
    }
    const entry = await openAnchoredLocalFile(root, from)
    if (!entry) return false
    try {
      await importLocalFile(root, to, entry.handle.createReadStream({ autoClose: false }), signal)
    } finally {
      await entry.handle.close()
    }
    return true
  }
  try {
    if (!await copy(source, staging)) return false
    signal.throwIfAborted()
    return await moveLocalEntry(root, staging, destination)
  } finally {
    await removeLocalTree(root, staging)
  }
}

export function createLocalFileTree(storageRoot: string, rootKey: string) {
  function path(relativePath: string, allowRoot = false) {
    if (relativePath === '' && allowRoot) return rootKey
    if (relativePath.length > 4096 || relativePath.split('/').some(segment =>
      !segment || segment === '.' || segment === '..' || segment.includes('\\')
      || segment.includes('\0') || segment.startsWith('.gugu-')))
      throw new UnsafeLocalPathError()
    return `${rootKey}/${relativePath}`
  }

  return {
    path,
    copy: (relativePath: string, destination: string, signal: AbortSignal) =>
      copyLocalEntry(storageRoot, path(relativePath), path(destination), signal),
    async ensureRoot() {
      // 只创建宿主提供的根目录层级，末段仅用于打开父目录句柄。
      const root = await openAnchoredParent(storageRoot, `${rootKey}/.gugu-root`, true)
      if (!root) return false
      await root.close()
      return true
    },
    async list(relativePath: string) {
      const entries = await listLocalDirectory(storageRoot, path(relativePath, true))
      return entries?.map(entry => ({
        ...entry,
        relativePath: relativePath ? `${relativePath}/${entry.name}` : entry.name,
      })) ?? null
    },
    open: (relativePath: string) => openAnchoredLocalFile(storageRoot, path(relativePath)),
    openDirectory: (relativePath: string) => openAnchoredLocalFile(storageRoot, path(relativePath, true), true),
    mkdir: (relativePath: string) => createLocalDirectory(storageRoot, path(relativePath)),
    upload: (relativePath: string, content: AsyncIterable<Uint8Array>, signal: AbortSignal, overwrite = false) =>
      importLocalFile(storageRoot, path(relativePath), content, signal, overwrite),
    async move(relativePath: string, destination: string) {
      const from = path(relativePath)
      const to = path(destination)
      if (to.startsWith(`${from}/`))
        throw Object.assign(new Error('不能移动到自身的子目录'), { code: 'EINVAL' })
      return moveLocalEntry(storageRoot, from, to)
    },
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

/** 从已授权的工作区根读取固定名称的规则文件。 */
export async function readWorkspaceAgentInstructions(root: string): Promise<string | undefined> {
  const maxBytes = 32 * 1024
  for (const name of ['AGENTS.md', 'agents.md']) {
    let handle
    try {
      handle = await open(path.join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const info = await handle.stat()
      if (!info.isFile() || info.size > maxBytes) return undefined
      const buffer = Buffer.alloc(maxBytes + 1)
      let length = 0
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
        if (!bytesRead) break
        length += bytesRead
      }
      if (length > maxBytes) return undefined
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)).trim() || undefined
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      if (error instanceof TypeError || ['ENOTDIR', 'ELOOP', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? ''))
        return undefined
      throw error
    } finally {
      await handle?.close()
    }
  }
}
