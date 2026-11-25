import type { Pool } from 'pg'
import type { Kysely } from 'kysely'
import { createWorkspaceShellDirectoryReader, createWorkspaceShellTargetReader } from '@gugu/core/workspaces/shell-target'
import { readPostgresProjectPathKey } from '../../files/paths.js'
import { personalFileRootPath, sandboxTarget, workspaceDirectoryPath } from '../../workspaces/roots.js'
import { CoreError } from '@gugu/core'
import { posix } from 'node:path'
import { createLocalFileTree, localEntryKind, readWorkspaceAgentInstructions } from '@gugu/fs/node'
import { createWorkspaceFileReads, resolveFileDirectoryRoot, type FileDirectory } from '../../workspaces/files.js'
import type { ShellTrashCommand } from '../shell/trash.js'
import { constants } from 'node:fs'
import { mkdir, open, type FileHandle } from 'node:fs/promises'

export { sandboxTarget } from '../../workspaces/roots.js'

/** 输入 key 必须由 owner 限定的数据库查询产生；不接收客户端提供的挂载列表。 */
export async function prepareTerminalMounts(root: string, owner: string, primaryKey: string, readonlyKeys: readonly string[], writableKeys: readonly string[], cwd: string, initializeKeys: ReadonlySet<string> = new Set()) {
  if (!writableKeys.includes(primaryKey) && !readonlyKeys.includes(primaryKey)) throw new Error('终端工作区未授权')
  const keys = [...new Set([...readonlyKeys, ...writableKeys])]
  if (keys.length > 64) throw new Error('终端挂载数量超限')
  const targets = new Map(keys.map(key => [key, sandboxTarget(key)]))
  const absolute = cwd.startsWith('/')
  const base = absolute
    ? keys.filter(key => cwd === targets.get(key) || cwd.startsWith(`${targets.get(key)}/`))
      .sort((a, b) => targets.get(b)!.length - targets.get(a)!.length)[0]
    : primaryKey
  if (!base) throw new Error('终端工作目录未授权')
  const target = targets.get(base)!
  const tail = absolute ? cwd.slice(target.length).replace(/^\//, '') : cwd
  const segments = (tail === '.' && !absolute) || tail === '' ? [] : tail.split('/')
  if (segments.some(part => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0')))
    throw new Error('终端工作目录无效')
  const pinned: Array<Awaited<ReturnType<typeof pinTerminalDirectory>>> = []
  try {
    const paths = new Map<string, string>()
    const descriptors = new Map<string, number>()
    for (const key of keys) {
      const item = await pinTerminalDirectory(root, owner, key, initializeKeys.has(key))
      pinned.push(item); paths.set(key, item.path)
      descriptors.set(key, item.fd)
    }
    const directory = await pinTerminalDirectory(root, owner, [base, ...segments].join('/'))
    pinned.push(directory)
    return {
      sandboxCwd: [target, ...segments].join('/'),
      sandboxMounts: keys.map(key => ({ source: paths.get(key)!, descriptor: descriptors.get(key)!,
        target: targets.get(key)!, readonly: !writableKeys.includes(key) })),
      cwd: directory.path, readonlyPaths: readonlyKeys.filter(key => !writableKeys.includes(key)).map(key => paths.get(key)!),
      readwritePaths: writableKeys.map(key => paths.get(key)!), environment: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      async close() { for (const item of pinned.reverse()) await item.close() } }
  } catch (error) {
    for (const item of pinned.reverse()) await item.close().catch(() => {})
    throw error
  }
}

/** 挂载来源来自 owner 限定的数据查询，不接受 HTTP 路径作为授权事实。 */
export function createTerminalWorkspaceMounts<DB>(pool: Pick<Pool, 'connect' | 'query'>, db: Kysely<DB>, storageRoot: string) {
  const files = createWorkspaceFileReads(pool, storageRoot)
  const target = createWorkspaceShellTargetReader(db, 'postgres')
  const directories = createWorkspaceShellDirectoryReader(db, 'postgres')
  async function resolvePrimary(owner: string, workspaceId: number | null) {
    if (workspaceId === null) return { selected: null, primary: personalFileRootPath(owner) }
    const selected = await target(owner, workspaceId)
    if (!selected) return null
    const client = await pool.connect()
    let primary: string
    try {
      if (selected.kind === 'directory') {
        primary = workspaceDirectoryPath(owner, selected.directoryName)
      } else primary = await readPostgresProjectPathKey(client, owner, selected.projectId)
    } finally { client.release() }
    return { selected, primary }
  }
  async function mounts(owner: string, workspaceId: number | null, fullUserSandboxWrite: boolean, cwd: string) {
    const resolved = await resolvePrimary(owner, workspaceId)
    if (!resolved) throw new Error('当前工作区挂载无法安全解析')
    const { selected, primary } = resolved
    const writable = selected ? [primary] : []
    const libraryRoots = [personalFileRootPath(owner), `${owner}/项目文件`]
    // 老账号尚未使用文件库时，声明可能早于实际目录。只补固定根，不重建已丢失的普通目录。
    const initialize = new Set(libraryRoots)
    if (selected?.kind === 'project') initialize.add(primary)
    const readonly = fullUserSandboxWrite ? [] : libraryRoots
    if (fullUserSandboxWrite) writable.push(...libraryRoots)
    const workspaceIds = new Map<string, number>()
    if (fullUserSandboxWrite) for (const directory of await directories(owner)) {
      if (directory.isDefault && directory.directoryName === 'default'
        && !(selected?.kind === 'directory' && selected.directoryId === directory.id)) continue
      const key = workspaceDirectoryPath(owner, directory.directoryName)
      writable.push(key)
      workspaceIds.set(key, directory.id)
    }
    const mount = await prepareTerminalMounts(storageRoot, owner, primary, readonly, [...new Set(writable)], cwd, initialize)
    const trashDirectory: FileDirectory = selected?.kind === 'directory' ? selected.directoryId
      : selected?.kind === 'project' ? { projectId: selected.projectId } : 'personal'
    async function resolveTrashTarget(path: string) {
      if (path.includes('\0') || path.includes('\\') || path.split('/').includes('..') || posix.basename(path) === '.') throw new CoreError('invalid_request', '删除路径不得越界')
      const absolute = posix.resolve(mount.sandboxCwd, path)
      const entry = mount.sandboxMounts.filter(entry => absolute.startsWith(entry.target + '/'))
        .sort((a, b) => b.target.length - a.target.length)[0]
      const key = entry && writable.find(key => sandboxTarget(key) === entry.target)
      if (entry?.readonly || !key || mount.sandboxMounts.some(entry => entry.target === absolute || entry.target.startsWith(absolute + '/')))
        throw new CoreError('invalid_request', '不能移除挂载根或未授权路径')
      const projectRoot = entry.target === '/project' && /^\/project\/(?:\d{4}\/\d{2}\/)?[^/]+ #(\d+)\//u.exec(absolute)
      const directory = key === primary ? trashDirectory : entry.target === '/personal' ? 'personal'
        : projectRoot ? { projectId: Number(projectRoot[1]) } : (workspaceIds.get(key) ?? null)
      if (directory === null) throw new CoreError('invalid_request', '请从文件库移除此目录中的文件')
      const root = await resolveFileDirectoryRoot(pool, owner, directory)
      const source = key + absolute.slice(sandboxTarget(key).length)
      if (!source.startsWith(root + '/')) throw new CoreError('invalid_request', '文件目录授权已变化')
      const relative = source.slice(root.length + 1)
      return { directory, relative, root, source, absolute }
    }
    return {
      ...mount,
      resolveTrashTarget,
      async trash(command: ShellTrashCommand, signal: AbortSignal) {
        const targets = new Map<string, { directory: FileDirectory; relative: string; root: string }>()
        for (const path of command.paths) {
          signal.throwIfAborted()
          const { directory, relative, root, source } = await resolveTrashTarget(path)
          const kind = await localEntryKind(storageRoot, createLocalFileTree(storageRoot, root).path(relative))
          if (targets.has(source) || (!kind && command.force)) continue
          if (!kind) throw new CoreError('invalid_request', '文件或目录不存在')
          if (kind === 'directory' && !command.recursive) throw new CoreError('invalid_request', '删除目录需要递归选项')
          targets.set(source, { directory, relative, root })
        }
        for (const source of targets.keys())
          if ([...targets.keys()].some(parent => source.startsWith(parent + '/')))
            throw new CoreError('invalid_request', '请勿同时删除父目录与其中的文件')
        let moved = 0
        for (const { directory, relative, root } of targets.values()) {
          signal.throwIfAborted()
          try {
            await files.moveToTrash(owner, directory, relative, { expectedRoot: root })
          } catch (error) {
            if (!(error instanceof CoreError) || moved === 0) throw error
            throw new CoreError('conflict', `已移入回收站 ${moved} 项，其余目标未处理：${error.message}`)
          }
          moved++
        }
        return moved
      },
    }
  }
  return Object.assign(mounts, {
    async readAgentInstructions(owner: string, workspaceId: number | null) {
      if (process.platform !== 'linux') return undefined
      const resolved = await resolvePrimary(owner, workspaceId)
      if (!resolved) return undefined
      let directory
      try { directory = await pinTerminalDirectory(storageRoot, owner, resolved.primary) }
      catch (error) {
        if (['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined
        throw error
      }
      try { return await readWorkspaceAgentInstructions(directory.path) }
      finally { await directory.close() }
    },
  })
}

/** Linux 目录逐层以 NOFOLLOW 打开，返回的句柄必须保持到子进程退出。 */
export async function pinTerminalDirectory(root: string, owner: string, key: string, initialize = false) {
  const segments = key.split('/')
  if (process.platform !== 'linux' || !/^[0-9a-f-]{36}$/i.test(owner) || segments[0] !== owner || segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\\') || segment.includes('\0')))
    throw new Error('终端目录无效')
  const handles: FileHandle[] = []
  try {
    let handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    handles.push(handle)
    for (const segment of segments) {
      const path = `/proc/self/fd/${handle.fd}/${segment}`
      const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      try { handle = await open(path, flags) }
      catch (error) {
        if (!initialize || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        // mkdir 与后续 open 锚定同一个父目录句柄，拒绝并发替换产生的符号链接。
        try { await mkdir(path, { mode: 0o770 }) }
        catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError }
        handle = await open(path, flags)
      }
      handles.push(handle)
    }
    let closed = false
    return { fd: handle.fd, path: `/proc/${process.pid}/fd/${handle.fd}`, async close() {
      if (closed) return
      closed = true
      for (const item of handles.reverse()) await item.close()
    } }
  } catch (error) {
    for (const handle of handles.reverse()) await handle.close().catch(() => {})
    throw error
  }
}
