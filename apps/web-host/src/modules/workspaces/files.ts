import { CoreError } from '@gugu/core'
import { resolveRelativeReferences } from '@gugu/core/files/relative-references'
import { createLocalFileTree, localFileIdentity, moveLocalEntry, removeLocalTree, UnsafeLocalPathError, watchDirectoryChanges } from '@gugu/fs/node'
import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { extractTar, extractZip } from '../files/archive/extract.js'
import { collectPathZipSources } from '../files/archive/path-sources.js'
import { writeZipStreams } from '../files/archive/write.js'
import { MAX_COMPRESS_SOURCE_BYTES, splitArchiveFilename, supportedArchiveFormat } from '../files/archive/rules.js'
import { lookup } from 'mime-types'
import type { Pool } from 'pg'
import { normalizeOwnerId } from '../../shared/owner-context.js'
import { projectFilePath, readPostgresProjectPathKey } from '../files/paths.js'
import { createDiskTrash } from '../files/trash/disk.js'
import { personalFileRootPath, sandboxTarget, workspaceDirectoryPath } from './roots.js'

export type FileDirectory = number | 'personal' | { projectId: number }

export async function resolveFileDirectoryRoot(pool: Pick<Pool, 'query'>, owner: string, directory: FileDirectory) {
  if (directory === 'personal') return personalFileRootPath(owner)
  if (typeof directory === 'object')
    return readPostgresProjectPathKey(pool, owner, directory.projectId)
  const { rows: [row] } = await pool.query<{ directory_name: string }>(
    `SELECT directory_name FROM workspace_directories
     WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, [directory, owner],
  )
  if (!row) throw new CoreError('not_found', '工作区不存在')
  return workspaceDirectoryPath(owner, row.directory_name)
}

export async function readPathDirectoryOverview(storageRoot: string, key: string, signal?: AbortSignal) {
  const tree = createLocalFileTree(storageRoot, key)
  let total = 0, rootFiles = 0, totalFolders = 0
  const folders: Array<{ name: string; path: string; file_count: number }> = []
  const files: Array<{ name: string; folder: string | null }> = []
  const pending = ['']
  while (pending.length) {
    signal?.throwIfAborted()
    const directory = pending.pop()!
    const entries = await tree.list(directory) ?? []
    for (const entry of entries) {
      if (entry.kind === 'directory') {
        totalFolders++
        pending.push(entry.relativePath)
        if (!directory && folders.length < 20) folders.push({ name: entry.name, path: entry.relativePath, file_count: 0 })
      } else {
        total++
        if (!directory) rootFiles++
        if (files.length < 20) files.push({ name: entry.name, folder: directory || null })
      }
    }
    const folder = folders.find(item => item.path === directory)
    if (folder) folder.file_count = entries.filter(entry => entry.kind === 'file').length
  }
  return { total, rootFiles, totalFolders, folders, files }
}

export function createWorkspaceFileReads(pool: Pick<Pool, 'query'>, storageRoot: string) {
  const rootKey = (owner: string, directory: FileDirectory) => resolveFileDirectoryRoot(pool, owner, directory)

  async function tree(ownerId: string, directory: FileDirectory) {
    return createLocalFileTree(storageRoot, await rootKey(normalizeOwnerId(ownerId), directory))
  }

  async function read<T>(operation: () => Promise<T | null>): Promise<T> {
    try {
      const result = await operation()
      if (result !== null) return result
    } catch (error) {
      if (!(error instanceof UnsafeLocalPathError)) throw error
    }
    throw new CoreError('not_found', '文件或目录不存在')
  }

  async function write(operation: () => Promise<unknown>) {
    try {
      if (await operation() !== false) return { ok: true }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ESTALE') throw new CoreError('conflict', '文件或目标目录已变化，无法撤销或重做')
      if (code === 'EEXIST' || code === 'ENOTEMPTY')
        throw new CoreError('conflict', '目标位置已存在同名文件或文件夹')
      if (code === 'EINVAL' || code === 'EXDEV')
        throw new CoreError('invalid_request', '不能移动到此位置')
      if (!(error instanceof UnsafeLocalPathError) && code !== 'ENOENT') throw error
    }
    throw new CoreError('not_found', '文件或目录不存在')
  }

  async function writeCreated(fs: ReturnType<typeof createLocalFileTree>, path: string, operation: () => Promise<unknown>) {
    let creationReceipt: string | undefined
    const result = await write(async () => {
      if (await operation() === false) return false
      creationReceipt = await fs.trashReceipt(path)
    })
    return { ...result, creationReceipt }
  }

  const trash = createDiskTrash(storageRoot, rootKey)

  function protectDownloadDirectory(directory: FileDirectory, path: string) {
    if (directory === 'personal' && path === 'download')
      throw new CoreError('invalid_request', '不能移动、替换或删除系统下载目录')
  }

  const storeTrashPath = (owner: string, directory: FileDirectory, path: string, root: string) => {
    protectDownloadDirectory(directory, path)
    return trash.store(owner, directory, path, createLocalFileTree(storageRoot, root).path(path), new Date().toISOString())
  }

  return {
    async openSandboxPath(ownerId: string, sandboxPath: string) {
      const owner = normalizeOwnerId(ownerId)
      if (!sandboxPath.startsWith('/') || sandboxPath.includes('\\') || /[\x00-\x1f\x7f]/u.test(sandboxPath))
        throw new CoreError('invalid_request', '文件库路径无效')
      const parts = sandboxPath.slice(1).split('/')
      if (parts.length < 2 || parts.some(part => !part || part === '.' || part === '..'))
        throw new CoreError('invalid_request', '文件库路径无效')
      const [projects, directories] = await Promise.all([
        pool.query<{ id: number; name: string; start_date: unknown; created_at: unknown }>(
          'SELECT id,name,start_date,created_at FROM projects WHERE user_id=$1 AND deleted_at IS NULL', [owner]),
        pool.query<{ id: number; directory_name: string }>(
          'SELECT id,directory_name FROM workspace_directories WHERE user_id=$1 AND deleted_at IS NULL', [owner]),
      ])
      const roots: Array<{ directory: FileDirectory; key: string }> = [
        { directory: 'personal', key: personalFileRootPath(owner) },
        ...projects.rows.map(row => ({ directory: { projectId: Number(row.id) } as const,
          key: projectFilePath(owner, Number(row.id), row.name, row.start_date, row.created_at) })),
        ...directories.rows.map(row => ({ directory: Number(row.id) as FileDirectory,
          key: workspaceDirectoryPath(owner, row.directory_name) })),
      ]
      const matches = roots.flatMap(root => {
        const prefix = sandboxTarget(root.key)
        return sandboxPath.startsWith(`${prefix}/`) ? [{ ...root, relativePath: sandboxPath.slice(prefix.length + 1) }] : []
      })
      if (matches.length !== 1) throw new CoreError('not_found', '文件不存在或无权访问')
      const opened = await read(() => tree(owner, matches[0]!.directory).then(fs => fs.open(matches[0]!.relativePath)))
      const identity = await localFileIdentity(opened.handle).catch(async error => {
        await opened.handle.close()
        throw error
      })
      if (!identity) {
        await opened.handle.close()
        throw new CoreError('not_found', '文件不存在或无权访问')
      }
      const fileName = matches[0]!.relativePath.split('/').at(-1)!
      return { ...opened, identity, fileName, mimeType: lookup(fileName) || 'application/octet-stream' }
    },
    async resolveRelative(ownerId: string, directory: FileDirectory, sourcePath: string, paths: readonly string[]) {
      const fs = await tree(ownerId, directory)
      const source = await read(() => fs.open(sourcePath))
      await source.handle.close()
      const sourceDirectory = sourcePath.split('/').slice(0, -1)
      const lookup = async (parts: readonly string[], name: string, kind: 'file' | 'directory') => {
        const relativePath = [...parts, name].join('/')
        const opened = await (kind === 'file' ? fs.open(relativePath) : fs.openDirectory(relativePath))
        if (!opened) return null
        await opened.handle.close()
        return { relativePath, name }
      }
      return resolveRelativeReferences(sourceDirectory, paths, {
        fileAt: (parts, name) => lookup(parts, name, 'file'),
        folderAt: (parts, name) => lookup(parts, name, 'directory'),
      })
    },
    async watchDirectory(ownerId: string, directory: FileDirectory, relativePath: string) {
      const owner = normalizeOwnerId(ownerId)
      const root = await rootKey(owner, directory)
      const fs = createLocalFileTree(storageRoot, root)
      const opened = await read(() => fs.openDirectory(relativePath))
      try {
        return watchDirectoryChanges(`/proc/self/fd/${opened.handle.fd}`, () => {
          void opened.handle.close().catch(() => {})
        }, async () => await rootKey(owner, directory) === root)
      } catch (error) {
        await opened.handle.close()
        throw error
      }
    },
    async list(ownerId: string, directory: FileDirectory, relativePath: string) {
      const fs = await tree(ownerId, directory)
      const entries = await read(async () => {
        const result = await fs.list(relativePath)
        return result ?? (typeof directory !== 'number' && relativePath === '' ? [] : null)
      })
      const results = []
      for (const entry of entries) {
        if (entry.kind === 'file') {
          results.push({ ...entry, mimeType: lookup(entry.name) || 'application/octet-stream' })
          continue
        }
        const children = await fs.list(entry.relativePath).catch(error => {
          if (error instanceof UnsafeLocalPathError || ['EACCES', 'EPERM'].includes(error.code)) return null
          throw error
        })
        const folderCount = children?.filter(child => child.kind === 'directory').length
        results.push({
          ...entry, mimeType: null,
          ...(children && folderCount !== undefined ? { folderCount, fileCount: children.length - folderCount } : {}),
        })
      }
      return results
    },
    async open(ownerId: string, directory: FileDirectory, relativePath: string, expectedIdentity?: string) {
      const fs = await tree(ownerId, directory)
      const opened = await read(() => fs.open(relativePath))
      if (expectedIdentity !== undefined) {
        try {
          if (await localFileIdentity(opened.handle) !== expectedIdentity)
            throw new CoreError('not_found', '引用文件已移动或不存在')
        } catch (error) {
          await opened.handle.close()
          throw error
        }
      }
      const fileName = relativePath.split('/').at(-1)!
      const mimeType = lookup(fileName) || 'application/octet-stream'
      return { ...opened, fileName, mimeType, file: null }
    },
    async reference(ownerId: string, directory: FileDirectory, relativePath: string, expectedIdentity?: string, type: 'file' | 'folder' = 'file') {
      const root = await rootKey(normalizeOwnerId(ownerId), directory)
      const fs = createLocalFileTree(storageRoot, root)
      const opened = await read(() => type === 'folder' ? fs.openDirectory(relativePath) : fs.open(relativePath))
      try {
        const identity = await localFileIdentity(opened.handle)
        if (!identity || (expectedIdentity !== undefined && expectedIdentity !== identity))
          throw new CoreError('not_found', '引用文件已移动或不存在')
        const directoryId = typeof directory === 'object' ? `project:${directory.projectId}` : directory
        const sandboxPath = relativePath ? `${sandboxTarget(root)}/${relativePath}` : sandboxTarget(root)
        const id = Buffer.from(JSON.stringify({ directoryId, relativePath, identity, ...(type === 'folder' ? { kind: type } : {}) })).toString('base64url')
        return { type, id: `path-${id}`, label: relativePath.split('/').at(-1)!, subtitle: sandboxPath, location: { kind: 'sandbox' as const, value: sandboxPath } }
      } finally {
        await opened.handle.close()
      }
    },
    async mkdir(ownerId: string, directory: FileDirectory, path: string) {
      const fs = await tree(ownerId, directory)
      return writeCreated(fs, path, async () => {
        if (typeof directory !== 'number' && !await fs.ensureRoot()) return false
        return fs.mkdir(path)
      })
    },
    async downloadArchive(ownerId: string, directory: FileDirectory, paths: readonly string[], signal: AbortSignal) {
      const owner = normalizeOwnerId(ownerId)
      const root = await rootKey(owner, directory)
      const fs = createLocalFileTree(storageRoot, root)
      if (!paths.length || paths.some(item => posix.dirname(item) !== posix.dirname(paths[0]!)))
        throw new CoreError('invalid_request', '下载内容必须位于同一目录')
      const sources = await collectPathZipSources(fs, paths, signal)
      const temporary = await mkdtemp(join(tmpdir(), 'gugu-path-download-'))
      try {
        const output = join(temporary, 'archive.zip')
        await writeZipStreams(sources, output)
        signal.throwIfAborted()
        if (root !== await rootKey(owner, directory)) throw new CoreError('conflict', '目标目录已变化')
        const stream = createReadStream(output, { signal })
        stream.once('close', () => {
          void rm(temporary, { recursive: true, force: true }).catch(() => {
            console.error('批量下载临时目录清理失败')
          })
        })
        return stream
      } catch (error) {
        await rm(temporary, { recursive: true, force: true })
        throw error
      }
    },
    async compressArchive(ownerId: string, directory: FileDirectory, paths: readonly string[], name: string, signal: AbortSignal) {
      const owner = normalizeOwnerId(ownerId)
      const root = await rootKey(owner, directory)
      const fs = createLocalFileTree(storageRoot, root)
      if (!name || name === '.' || name === '..' || name.startsWith('.gugu-')
        || Buffer.byteLength(name) > 250 || /[/\\\p{Cc}]/u.test(name))
        throw new CoreError('invalid_request', '压缩包名称无效')
      if (!paths.length || paths.some(item => posix.dirname(item) !== posix.dirname(paths[0]!)))
        throw new CoreError('invalid_request', '压缩内容必须位于同一目录')
      const parent = posix.dirname(paths[0]!)
      const relativePath = posix.join(parent === '.' ? '' : parent, `${name}.zip`)
      const sources = await collectPathZipSources(fs, paths, signal)
      const temporary = await mkdtemp(join(tmpdir(), 'gugu-path-compress-'))
      try {
        const output = join(temporary, 'archive.zip')
        await writeZipStreams(sources, output)
        signal.throwIfAborted()
        if (root !== await rootKey(owner, directory)) throw new CoreError('conflict', '目标目录已变化')
        const result = await writeCreated(fs, relativePath, () => fs.upload(relativePath, createReadStream(output), signal))
        return { relativePath, creationReceipt: result.creationReceipt }
      } finally { await rm(temporary, { recursive: true, force: true }) }
    },
    async extractArchive(ownerId: string, directory: FileDirectory, path: string, folderName: string, signal: AbortSignal) {
      const owner = normalizeOwnerId(ownerId)
      const root = await rootKey(owner, directory)
      const fs = createLocalFileTree(storageRoot, root)
      if (!folderName || folderName === '.' || folderName === '..' || folderName.startsWith('.gugu-')
        || Buffer.byteLength(folderName) > 255 || /[/\\\p{Cc}]/u.test(folderName))
        throw new CoreError('invalid_request', '解压文件夹名称无效')
      const parent = posix.dirname(path)
      const relativePath = posix.join(parent === '.' ? '' : parent, folderName)
      const { displayName, ext } = splitArchiveFilename(posix.basename(path))
      const format = supportedArchiveFormat(displayName, ext)
      if (!format) throw new CoreError('invalid_request', '不支持此压缩格式')
      const source = await read(() => fs.open(path))
      try {
        if (source.size > MAX_COMPRESS_SOURCE_BYTES) throw new CoreError('conflict', '压缩包超过安全上限')
        const temporary = await mkdtemp(join(tmpdir(), 'gugu-path-extract-'))
        try {
          const input = join(temporary, 'archive')
          async function* archiveBytes() {
            let offset = 0
            while (offset <= MAX_COMPRESS_SOURCE_BYTES) {
              signal.throwIfAborted()
              const buffer = Buffer.allocUnsafe(64 * 1024)
              const { bytesRead } = await source.handle.read(buffer, 0, buffer.length, offset)
              if (bytesRead === 0) return
              offset += bytesRead
              if (offset > MAX_COMPRESS_SOURCE_BYTES) throw new CoreError('conflict', '压缩包超过安全上限')
              yield buffer.subarray(0, bytesRead)
            }
          }
          await pipeline(archiveBytes(), createWriteStream(input, { flags: 'wx', mode: 0o600 }), { signal })
          const extracted = await (format === 'zip'
            ? extractZip(input, temporary)
            : extractTar(input, temporary, /(?:\.tar\.gz|\.tgz)$/iu.test(path))).catch(error => {
            if (error instanceof CoreError) throw error
            throw new CoreError('invalid_request', '压缩包损坏')
          })
          const stagedKey = `${owner}/.gugu-archive-${randomUUID()}`
          const staged = createLocalFileTree(storageRoot, stagedKey)
          const directories = new Set<string>([''])
          async function ensureDirectory(path: string): Promise<void> {
            if (directories.has(path)) return
            const parent = posix.dirname(path)
            await ensureDirectory(parent === '.' ? '' : parent)
            if (!await staged.mkdir(path)) throw new CoreError('conflict', '压缩包目录冲突')
            directories.add(path)
          }
          try {
            if (!await staged.ensureRoot()) throw new CoreError('storage_error', '无法创建解压目录')
            for (const member of extracted.members) {
              signal.throwIfAborted()
              if (member.kind === 'folder') await ensureDirectory(member.archivePath)
              else {
                const parent = posix.dirname(member.archivePath)
                await ensureDirectory(parent === '.' ? '' : parent)
                await write(() => staged.upload(member.archivePath, createReadStream(member.stagedPath!), signal))
              }
            }
            if (root !== await rootKey(owner, directory)) throw new CoreError('conflict', '目标目录已变化')
            signal.throwIfAborted()
            const result = await writeCreated(fs, relativePath, () => moveLocalEntry(storageRoot, stagedKey, fs.path(relativePath)))
            return { relativePath, skipped: extracted.skipped, creationReceipt: result.creationReceipt }
          } finally { await removeLocalTree(storageRoot, stagedKey) }
        } finally { await rm(temporary, { recursive: true, force: true }) }
      } finally { await source.handle.close() }
    },
    async upload(ownerId: string, directory: FileDirectory, path: string, content: AsyncIterable<Uint8Array>, signal: AbortSignal, overwrite = false) {
      protectDownloadDirectory(directory, path)
      const owner = normalizeOwnerId(ownerId)
      const root = await rootKey(owner, directory)
      const fs = createLocalFileTree(storageRoot, root)
      if (overwrite) return write(() => fs.upload(path, content, signal, true))
      return writeCreated(fs, path, async () => {
        if (typeof directory !== 'number' && !await fs.ensureRoot()) return false
        return fs.upload(path, content, signal)
      })
    },
    async move(ownerId: string, directory: FileDirectory, path: string, destination: string, track?: { expected?: string }) {
      protectDownloadDirectory(directory, path)
      protectDownloadDirectory(directory, destination)
      const owner = normalizeOwnerId(ownerId)
      const root = await rootKey(owner, directory)
      const history = track && { ...track, reverse: undefined as string | undefined }
      const result = await write(() => createLocalFileTree(storageRoot, root).move(path, destination, history))
      return history?.reverse ? { ...result, moveReceipt: history.reverse } : result
    },
    async copy(ownerId: string, directory: FileDirectory, path: string, destination: string, signal: AbortSignal) {
      protectDownloadDirectory(directory, destination)
      const fs = await tree(ownerId, directory)
      return writeCreated(fs, destination, () => fs.copy(path, destination, signal))
    },
    async moveToTrash(ownerId: string, directory: FileDirectory, path: string, options?: { expectedRoot: string }) {
      const owner = normalizeOwnerId(ownerId)
      const root = await rootKey(owner, directory)
      if (options && options.expectedRoot !== root) throw new CoreError('conflict', '文件目录授权已变化')
      return write(() => storeTrashPath(owner, directory, path, root))
    },
    async applyTrashHistory(ownerId: string, directory: FileDirectory, path: string, expected?: string, id?: string) {
      protectDownloadDirectory(directory, path)
      const owner = normalizeOwnerId(ownerId)
      const root = await rootKey(owner, directory)
      const source = createLocalFileTree(storageRoot, root).path(path)
      const history = { expected, reverse: undefined as string | undefined }
      if (id !== undefined) {
        const entry = await trash.info(owner, id)
        if (!entry || entry.relativePath !== path || root !== await rootKey(owner, entry.directory))
          throw new CoreError('conflict', '回收项已变化')
        const tracking = { ...history, trash: 'restore' as const }
        await write(() => trash.restore(owner, id, root, tracking))
        return { receipt: tracking.reverse }
      }
      const tracking = { ...history, trash: 'store' as const }
      let trashId: string | undefined
      await write(async () => {
        const entry = await trash.store(owner, directory, path, source, new Date().toISOString(), tracking)
        if (!entry) return false
        trashId = entry.id
      })
      return { id: trashId, receipt: tracking.reverse }
    },
    async trashPath(ownerId: string, directory: FileDirectory, path: string, expectedRoot: string) {
      const owner = normalizeOwnerId(ownerId)
      const root = await rootKey(owner, directory)
      if (expectedRoot !== root) throw new CoreError('conflict', '文件目录授权已变化')
      const entry = await storeTrashPath(owner, directory, path, root)
      if (!entry) throw new CoreError('not_found', '文件或目录不存在')
      return entry
    },
    listDiskTrash: (ownerId: string) => trash.list(normalizeOwnerId(ownerId)),
    getDiskTrash: (ownerId: string, id: string) => trash.info(normalizeOwnerId(ownerId), id),
    restoreDiskTrash: (ownerId: string, id: string, expectedRoot?: string) => write(() => trash.restore(normalizeOwnerId(ownerId), id, expectedRoot)),
    purgeDiskTrash: (ownerId: string, id: string) => write(() => trash.purge(normalizeOwnerId(ownerId), id)),
  }
}
