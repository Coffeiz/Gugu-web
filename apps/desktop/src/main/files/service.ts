import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { cp, link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { agentDownloadsLimit } from '@gugu/core/tools'
import { DesktopError } from '../core-host.js'
import { fileWorkspaces } from './workspaces.js'
import { resolveProjectFileRoot, type ReadProjectFilesMetadata } from './project-root.js'
import type { DesktopFileDirectory } from '@gugu/core/desktop'

export function encodeWorkspaceFileReferenceId(file: { directoryId: DesktopFileDirectory; relativePath: string; identity?: string }) {
  if (!file.identity) throw new DesktopError('not_found', '文件身份无效')
  return 'path-' + Buffer.from(JSON.stringify(file)).toString('base64url')
}

const maxUpload = 32 * 1024 * 1024
const mimeTypes: Record<string, string> = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json',
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
}
const mime = (name: string) => mimeTypes[extname(name).toLowerCase()] ?? null

function segments(path: unknown, allowEmpty = false): string[] {
  if (path === '' && allowEmpty) return []
  if (typeof path !== 'string' || path.length > 4096) throw new DesktopError('invalid_request', '文件路径无效')
  const parts = path.split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || part.toLowerCase().startsWith('.gugu-')
    || /[\\:\x00-\x1f<>"|?*]/.test(part) || /[. ]$/.test(part)
    || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)))
    throw new DesktopError('invalid_request', '文件路径无效')
  return parts
}

const identityOf = (info: { dev: bigint; ino: bigint; birthtimeNs: bigint }) => `${info.dev}.${info.ino}.${info.birthtimeNs}`
function assertInside(root: string, candidate: string) {
  const path = relative(root, candidate)
  if (isAbsolute(path) || path === '..' || path.startsWith('..' + sep))
    throw new DesktopError('forbidden', '文件不在工作区内')
}

type NativeFileOperations = {
  save(name: string): Promise<string | undefined>
  reveal(path: string): void
  open(path: string): Promise<string>
  pickDirectory(): Promise<string | undefined>
  trash(path: string): Promise<void>
  thumbnail?(bytes: Buffer, name: string): Promise<Buffer | undefined>
}

function workspaceFiles(directoryId: DesktopFileDirectory, workspace: () => Promise<string>, native?: NativeFileOperations) {
  async function locate(parts: string[]) {
    const base = await workspace()
    let path = base
    for (const part of parts) {
      path = join(path, part)
      const info = await lstat(path, { bigint: true })
      if (info.isSymbolicLink()) throw new DesktopError('forbidden', '工作区不支持链接文件')
    }
    assertInside(base, await realpath(path))
    return path
  }
  async function locateFile(path: unknown, identity?: unknown) {
    const file = await locate(segments(path))
    const info = await lstat(file, { bigint: true })
    if (!info.isFile()) throw new DesktopError('invalid_request', '请选择普通文件')
    if (identity !== undefined && identity !== identityOf(info)) throw new DesktopError('not_found', '文件已移动或替换')
    return file
  }
  async function destination(parts: string[]) {
    return join(await locate(parts.slice(0, -1)), parts.at(-1)!)
  }
  async function list(path: unknown, includeModifiedAt = false, includeCounts = false) {
    const parts = segments(path, true)
    const directory = await locate(parts)
    const entries = await readdir(directory, { withFileTypes: true })
    const results: Array<{
      name: string; relativePath: string; kind: 'directory' | 'file'; size: number
      mimeType: string | null; modifiedAt?: number; fileCount?: number; folderCount?: number
    }> = []
    for (const entry of entries) {
      try { segments(entry.name) } catch { continue }
      if (!entry.isFile() && !entry.isDirectory()) continue
      const info = await lstat(join(directory, entry.name)).catch(error => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (!info || (!info.isDirectory() && !info.isFile())) continue
      let counts: { fileCount: number; folderCount: number } | undefined
      if (includeCounts && info.isDirectory()) {
        const children = await list([...parts, entry.name].join('/')).catch(error => {
          if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)
            || (error instanceof DesktopError && error.code === 'forbidden')) return null
          throw error
        })
        if (children) {
          const folderCount = children.filter(child => child.kind === 'directory').length
          counts = { folderCount, fileCount: children.length - folderCount }
        }
      }
      results.push({
        ...counts,
        name: entry.name, relativePath: [...parts, entry.name].join('/'),
        kind: info.isDirectory() ? 'directory' as const : 'file' as const,
        size: info.isFile() ? info.size : 0, mimeType: info.isFile() ? mime(entry.name) : null,
        ...(includeModifiedAt && info.isFile() ? { modifiedAt: info.mtimeMs } : {}),
      })
    }
    return results
  }
  type ReferenceTarget = { directoryId: DesktopFileDirectory; relativePath: string }
  async function reference(path: unknown, target?: ReferenceTarget) {
    const parts = segments(path)
    const info = await lstat(await locate(parts), { bigint: true })
    if (!info.isFile()) throw new DesktopError('invalid_request', '请选择普通文件')
    const id = encodeWorkspaceFileReferenceId({ ...(target ?? { directoryId, relativePath: parts.join('/') }), identity: identityOf(info) })
    return { type: 'file' as const, id, label: parts.at(-1)! }
  }

  async function* scan(budget: { remaining: number }) {
    const queue = ['']
    for (const folder of queue) {
      if (budget.remaining <= 0) return
      for (const entry of await list(folder)) {
        if (budget.remaining <= 0) return
        budget.remaining--
        if (entry.kind === 'directory') queue.push(entry.relativePath)
        yield entry
      }
    }
  }

  async function search(
    query: unknown,
    budget = { remaining: 5000 },
    resolveTarget?: (path: string) => Promise<ReferenceTarget | null>,
    exact = false,
  ) {
    if (typeof query !== 'string' || !query.trim() || query.length > (exact ? 255 : 120)) return []
    const needle = query.trim().toLocaleLowerCase()
    const results = []
    for await (const entry of scan(budget)) {
      if (entry.kind !== 'file' || !(exact ? entry.name === query : entry.name.toLocaleLowerCase().includes(needle))) continue
      const target = await resolveTarget?.(entry.relativePath)
      if (target === null) continue
      results.push({ ...await reference(entry.relativePath, target), subtitle: entry.relativePath })
      if (results.length >= 30) break
    }
    return results
  }

  async function read(path: unknown, identity?: string) {
    const parts = segments(path)
    const actual = await locate(parts)
    const expected = await lstat(actual, { bigint: true })
    if (!expected.isFile()) throw new DesktopError('not_found', '文件不存在')
    const handle = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const info = await handle.stat({ bigint: true })
      if (identityOf(info) !== identityOf(expected) || (identity && identityOf(info) !== identity))
        throw new DesktopError('not_found', '文件已移动或被替换')
      assertInside(await workspace(), await realpath(actual))
      return { handle, size: Number(info.size), type: mime(actual) ?? 'application/octet-stream', name: basename(actual) }
    } catch (error) {
      await handle.close()
      throw error
    }
  }

  async function resolveAgentPath(parts: string[]) {
    const actual = await locate(parts)
    const info = await lstat(actual, { bigint: true })
    if (!info.isFile()) throw new DesktopError('not_found', '文件不存在')
    return { root: await workspace(), relativePath: parts.join('/') }
  }

  async function preview(path: unknown, identity?: string) {
    const parts = segments(path)
    const actual = await locate(parts)
    const info = await lstat(actual, { bigint: true })
    if (!info.isFile()) throw new DesktopError('invalid_request', '请选择普通文件')
    if (identity !== undefined && identity !== identityOf(info)) throw new DesktopError('not_found', '文件已移动或替换')
    return {
      workspaceFile: { directoryId, relativePath: parts.join('/'), identity: identityOf(info) },
      displayName: basename(actual), ext: extname(actual).slice(1).toLowerCase(),
      mimeType: mime(actual), sizeBytes: Number(info.size),
    }
  }

  async function upload(path: unknown, data: unknown, overwrite: boolean, identity?: string) {
    if (!(data instanceof Uint8Array) || data.byteLength > maxUpload)
      throw new DesktopError('invalid_request', '单个文件最大支持 32 MB')
    await writeAtomically(path, temp => writeFile(temp, data, { flag: 'wx', mode: 0o600 }), overwrite, identity)
  }

  async function writeAtomically(path: unknown, stage: (temp: string) => Promise<void>, overwrite = false,
    identity?: string, beforeCommit?: () => Promise<void>) {
    const parts = segments(path)
    const target = await destination(parts)
    const before = await lstat(dirname(target), { bigint: true })
    const temp = join(dirname(target), `.gugu-write-${randomUUID()}`)
    try {
      await stage(temp)
      await beforeCommit?.()
      const validTarget = await destination(parts)
      if (validTarget !== target || identityOf(await lstat(dirname(validTarget), { bigint: true })) !== identityOf(before))
        throw new DesktopError('conflict', '文件目录已变化')
      if (overwrite) {
        const original = await read(path, identity)
        await original.handle.close()
        await rename(temp, target)
      } else await link(temp, target)
    } finally { await rm(temp, { force: true }) }
  }

  async function move(path: unknown, next: unknown, copy: boolean) {
    const source = await locate(segments(path))
    const target = await destination(segments(next))
    if (source === target) return
    const nested = relative(source, target)
    if (!isAbsolute(nested) && nested !== '..' && !nested.startsWith('..' + sep))
      throw new DesktopError('invalid_request', '不能将文件夹放进自身')
    // 复制先占位，避免同名时覆盖。移动文件用硬链接保留原有文件身份。
    const info = await lstat(source)
    if (!info.isFile() && !info.isDirectory()) throw new DesktopError('forbidden', '不支持此文件类型')
    if (copy) {
      if (info.isDirectory()) {
        await mkdir(target)
        try {
          for (const entry of await readdir(source)) await cp(join(source, entry), join(target, entry), {
            recursive: true, force: false, errorOnExist: true,
            filter: async candidate => (await lstat(candidate)).isSymbolicLink() === false,
          })
        } catch (error) { await rm(target, { recursive: true, force: true }); throw error }
      } else await cp(source, target, { force: false, errorOnExist: true })
    } else if (info.isFile()) {
      await link(source, target)
      await rm(source)
    } else {
      await mkdir(target)
      try { await rename(source, target) } catch (error) { await rmdir(target); throw error }
    }
  }

  async function trash(path: unknown) {
    if (!native) throw new DesktopError('unsupported', '请在桌面应用中移入系统回收站')
    const source = await locate(segments(path))
    try {
      await native.trash(source)
    } catch {
      throw new DesktopError('conflict', '无法移入系统回收站，请检查目录权限或文件占用状态')
    }
  }

  async function download(path: unknown, identity?: string) {
    if (!native) throw new DesktopError('unsupported', '浏览器预览使用浏览器下载')
    const parts = segments(path)
    const target = await native.save(parts.at(-1)!)
    if (!target) return
    const source = await read(path, identity)
    const staged = join(dirname(target), `.gugu-export-${randomUUID()}`)
    try {
      const output = await open(staged, 'wx', 0o600)
      await pipeline(source.handle.createReadStream(), output.createWriteStream())
      await rename(staged, target)
    } finally {
      await source.handle.close()
      await rm(staged, { force: true })
    }
  }

  async function content(url: URL, range: string | null, metadata = false) {
    const { handle, size, type, name } = await read(url.searchParams.get('path'), url.searchParams.get('identity') || undefined)
    if (metadata) {
      await handle.close()
      return Response.json({ name, size }, { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
    }
    const download = url.searchParams.get('download') === '1'
    const headers = new Headers({
      'Content-Type': type, 'Content-Length': String(size), 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes',
    })
    if (url.searchParams.get('thumbnail') === '1') {
      try {
        if (!type.startsWith('image/') || size === 0 || size > 8 * 1024 * 1024)
          return new Response(null, { status: 404 })
        const bytes = Buffer.alloc(size)
        const { bytesRead } = await handle.read(bytes, 0, size, 0)
        if (bytesRead !== size) return new Response(null, { status: 404 })
        let thumbnail: Buffer | undefined = bytes
        if (native?.thumbnail) {
          thumbnail = await native.thumbnail(bytes, name).catch(() => undefined)
          headers.set('Content-Type', 'image/png')
        }
        if (!thumbnail?.length) return new Response(null, { status: 404 })
        headers.set('Content-Length', String(thumbnail.length))
        headers.delete('Accept-Ranges')
        return new Response(new Uint8Array(thumbnail), { headers })
      } finally {
        await handle.close()
      }
    }
    if (download) headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}`)
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range)
      const start = match ? Number(match[1]) : NaN
      const end = match?.[2] ? Math.min(size - 1, Number(match[2])) : size - 1
      if (!Number.isSafeInteger(start) || start < 0 || start > end) {
        await handle.close()
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
      }
      headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
      headers.set('Content-Length', String(end - start + 1))
      return new Response(Readable.toWeb(handle.createReadStream({ start, end })) as ReadableStream<Uint8Array>, { status: 206, headers })
    }
    return new Response(Readable.toWeb(handle.createReadStream()) as ReadableStream<Uint8Array>, { headers })
  }

  async function scanOverview(signal?: AbortSignal) {
    const queue = ['']
    const folderCounts = new Map<string, number>()
    const recent: Array<{ name: string; folder: string | null; modified: number }> = []
    let total = 0
    let rootFiles = 0
    let totalFolders = 0
    let scanned = 0
    let scanLimited = false
    const maximumEntries = 5000
    while (queue.length && scanned < maximumEntries) {
      signal?.throwIfAborted()
      const current = queue.shift()!
      for (const entry of await list(current, true)) {
        if (scanned >= maximumEntries) {
          scanLimited = true
          break
        }
        scanned++
        const rootFolder = entry.relativePath.split('/')[0]!
        if (entry.kind === 'directory') {
          totalFolders++
          if (!current) folderCounts.set(rootFolder, 0)
          queue.push(entry.relativePath)
          continue
        }
        total++
        if (!current) rootFiles++
        if (current) folderCounts.set(rootFolder, (folderCounts.get(rootFolder) ?? 0) + 1)
        recent.push({ name: entry.name, folder: current || null, modified: entry.modifiedAt ?? 0 })
        if (recent.length > 40) {
          recent.sort((a, b) => b.modified - a.modified)
          recent.length = 20
        }
      }
    }
    recent.sort((a, b) => b.modified - a.modified)
    const folders = [...folderCounts].map(([name, file_count]) => ({ name, path: name, file_count }))
      .sort((a, b) => a.name.localeCompare(b.name))
    const incomplete = scanLimited || queue.length > 0
    return {
      counts: { total_file_count: total, root_file_count: rootFiles, total_folder_count: totalFolders },
      incomplete,
      overview: {
        total, folders: folders.slice(0, 100),
        files: recent.slice(0, 20).map(({ name, folder }) => ({ name, folder: folder?.slice(0, 200) ?? null, space: 'personal' })),
        partial: incomplete || folders.length > 100,
      },
    }
  }

  return { list, scan, reference, search, destination, upload, writeAtomically, move, trash, download, locate, locateFile, content, scanOverview, resolveAgentPath, preview, read }
}

export function createDesktopFileService(root: string, native?: NativeFileOperations, registry?: string, protectedRoot?: string, readProject?: ReadProjectFilesMetadata) {
  const workspaces = fileWorkspaces(root, registry, protectedRoot)
  const projectOperations = new Map<string, Promise<unknown>>()
  const attachmentSaveOperations = new Map<string, Promise<void>>()
  async function withDirectory<T>(directoryId: unknown, operation: () => Promise<T>) {
    if (typeof directoryId !== 'string' || !directoryId.startsWith('project:')) return operation()
    const previous = projectOperations.get(directoryId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(operation)
    projectOperations.set(directoryId, next)
    try { return await next }
    finally { if (projectOperations.get(directoryId) === next) projectOperations.delete(directoryId) }
  }

  const scope = async (directoryId: unknown, create = false) => {
    if (typeof directoryId === 'string' && directoryId.startsWith('project:')) {
      const id = Number(directoryId.slice('project:'.length))
      if (!Number.isSafeInteger(id) || id < 1 || directoryId !== `project:${id}`)
        throw new DesktopError('invalid_request', '项目标识无效')
      if (!readProject) throw new DesktopError('unsupported', '当前环境不支持项目文件')
      const project = await readProject(id)
      if (project.deletedAt) throw new DesktopError('not_found', '项目不存在')
      const projectRoot = await resolveProjectFileRoot((await workspaces.managedRoots()).project, id, project, create)
      if (!projectRoot) return null
      return workspaceFiles(directoryId as `project:${number}`, async () => projectRoot, native)
    }
    const binding = await workspaces.get(directoryId)
    return workspaceFiles(binding.id, () => workspaces.resolveRoot(binding), native)
  }
  async function resolveAgentFile(path: unknown) {
    if (typeof path !== 'string' || path.length > 2048 || !path.startsWith('/') || path.includes('\\') || path.includes('\0')) return null
    const parts = path.slice(1).split('/')
    if (parts.length < 2 || parts.some(part => !part || part === '.' || part === '..')) return null
    const space = parts.shift()
    let directoryId: DesktopFileDirectory
    let relativeParts: string[]
    if (space === 'personal') {
      directoryId = 'personal'
      relativeParts = parts
    } else if (space === 'workspace') {
      const name = parts.shift()
      if (!name) return null
      const bindings = (await workspaces.list()).filter(binding => binding.name === name)
      if (bindings.length !== 1 || bindings[0]!.id === 'personal') return null
      directoryId = bindings[0]!.id
      relativeParts = parts
    } else if (space === 'project') {
      if (!readProject) return null
      const projectIndex = parts.findIndex(part => / #([1-9]\d*)$/u.test(part))
      if (projectIndex < 0) return null
      const projectPath = parts[projectIndex]!
      const id = Number(projectPath.slice(projectPath.lastIndexOf('#') + 1))
      if (!Number.isSafeInteger(id)) return null
      let project: Awaited<ReturnType<ReadProjectFilesMetadata>>
      try { project = await readProject(id) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'not_found') return null
        throw error
      }
      const expectedName = project.name.replace(/[\x00-\x1f]/gu, '_')
      if (project.deletedAt || projectPath !== `${expectedName} #${id}`) return null
      if (projectIndex > 0 && !(projectIndex === 2 && /^\d{4}$/u.test(parts[0]!) && /^(0[1-9]|1[0-2])$/u.test(parts[1]!))) return null
      directoryId = `project:${id}`
      relativeParts = parts.slice(projectIndex + 1)
      if (!relativeParts.length) return null
    } else return null
    if (!relativeParts.length) return null
    const files = await scope(directoryId)
    if (!files) return null
    const resolved = await files.resolveAgentPath(relativeParts)
    const previewFile = await files.preview(relativeParts.join('/'))
    const name = relativeParts.at(-1)!
    const extension = extname(name).slice(1).toLowerCase()
    const textExtensions = new Set(['md', 'txt', 'json', 'csv', 'yaml', 'yml', 'log', 'py', 'js', 'ts', 'tsx', 'jsx', 'vue', 'html', 'css', 'scss', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'hpp', 'sh', 'sql', 'xml', 'toml', 'ini', 'conf', 'env', 'tex', 'svg'])
    return { id: undefined, name, ...resolved, previewFile, text: textExtensions.has(extension), extensionless: !extension, ...(extension ? { extension } : {}) }
  }
  function projectSearchTarget(readProject: ReadProjectFilesMetadata) {
    const lookup = new Map<number, Promise<boolean>>()
    return async (path: string) => {
      const match = /^(?:\d{4}\/\d{2}\/)?[^/]+ #([1-9]\d*)\/(.+)$/u.exec(path)
      if (!match) return null
      const id = Number(match[1])
      if (!Number.isSafeInteger(id)) return null
      if (!lookup.has(id)) {
        lookup.set(id, readProject(id).then(project => !project.deletedAt, error => {
          if ((error as NodeJS.ErrnoException).code === 'not_found') return false
          throw error
        }))
      }
      if (!await lookup.get(id)) return null
      return { directoryId: `project:${id}` as const, relativePath: match[2]! }
    }
  }

  async function searchProjects(query: unknown, budget: { remaining: number }, exact = false) {
    if (!readProject) return []
    const { project } = await workspaces.managedRoots()
    return workspaceFiles('personal', async () => project).search(query, budget, projectSearchTarget(readProject), exact)
  }

  async function searchWorkspaces(query: unknown, directoryId: unknown, exact = false) {
    if (directoryId !== undefined) return (await scope(directoryId))?.search(query) ?? []
    const results = []
    const budget = { remaining: 5000 }
    for (const { id, name } of await workspaces.list()) {
      try {
        const items = await (await scope(id))?.search(query, budget, undefined, exact) ?? []
        results.push(...items.map(item => ({ ...item, subtitle: `${name} / ${item.subtitle}` })))
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (!['ENOENT', 'EACCES', 'EPERM', 'forbidden'].includes(code ?? '')) throw error
      }
      if (results.length >= 30 || budget.remaining <= 0) break
    }
    if (results.length < 30 && budget.remaining > 0) {
      const projects = await searchProjects(query, budget, exact)
      results.push(...projects.map(item => ({ ...item, subtitle: `项目文件 / ${item.subtitle}` })))
    }
    if (exact && budget.remaining <= 0 && results.length < 2) return []
    return results.slice(0, 30)
  }

  async function globalFileSearch(queries: readonly string[], mode: 'OR' | 'AND' = 'OR', perType = 6, signal?: AbortSignal) {
    const terms = queries.map(term => term.startsWith('/') ? term : term.normalize('NFC').toLowerCase())
    const budget = { remaining: 10000 }
    type Item = { id: string; title: string; subtitle: string; path_file: {
      directoryId: DesktopFileDirectory; directoryName: string; relativePath: string; sandboxPath: string
    } }
    const groups = {
      file: { type: 'file' as const, label: '文件', results: [] as Array<{ item: Item; hits: number; rank: number }> },
      folder: { type: 'folder' as const, label: '文件夹', results: [] as Array<{ item: Item; hits: number; rank: number }> },
    }
    async function collect(files: ReturnType<typeof workspaceFiles>, directoryName: string,
      logicalPath: (relativePath: string) => string,
      targetFor: (relativePath: string) => Promise<{ directoryId: DesktopFileDirectory; relativePath: string } | null>) {
      try {
        for await (const entry of files.scan(budget)) {
          signal?.throwIfAborted()
          const scannedPath = entry.relativePath.normalize('NFC').toLowerCase()
          const sandboxPath = logicalPath(entry.relativePath)
          if (!terms.some(term => term.startsWith('/') ? sandboxPath === term : scannedPath.includes(term))) continue
          const target = await targetFor(entry.relativePath)
          if (!target) continue
          const path = target.relativePath.normalize('NFC').toLowerCase()
          const hits = terms.filter(term => term.startsWith('/') ? sandboxPath === term : path.includes(term)).length
          if (mode === 'AND' ? hits !== terms.length : !hits) continue
          const title = entry.name.normalize('NFC').toLowerCase()
          const primary = terms[0]!
          const rank = title === primary ? 0 : title.startsWith(primary) ? 1 : title.includes(primary) ? 2 : 3
          const result = groups[entry.kind === 'file' ? 'file' : 'folder'].results
          result.push({ item: {
            id: JSON.stringify([target.directoryId, target.relativePath]), title: entry.name,
            subtitle: [directoryName, target.relativePath.split('/').slice(0, -1).join('/')].filter(Boolean).join(' · '),
            path_file: { ...target, directoryName, sandboxPath },
          }, hits, rank })
          result.sort((left, right) => right.hits - left.hits || left.rank - right.rank || left.item.title.localeCompare(right.item.title))
          if (result.length > perType) result.pop()
        }
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'forbidden', 'conflict', 'not_found'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      }
    }
    if (terms.length) {
      for (const { id, name } of await workspaces.list()) {
        if (budget.remaining <= 0) break
        const files = await scope(id)
        if (files) await collect(files, name, path => id === 'personal' ? `/personal/${path}` : `/workspace/${name}/${path}`,
          async relativePath => ({ directoryId: id, relativePath }))
      }
      if (readProject && budget.remaining > 0) {
        const { project } = await workspaces.managedRoots()
        await collect(workspaceFiles('personal', async () => project), '项目文件', path => '/project/' + path, projectSearchTarget(readProject))
      }
    }
    return {
      partial: budget.remaining === 0,
      groups: Object.values(groups).filter(group => group.results.length)
        .map(({ type, label, results }) => ({ type, label, items: results.map(({ item }) => item) })),
    }
  }

  async function resolveWorkspaceReference(id: string) {
    if (!/^path-[A-Za-z0-9_-]{1,24000}$/u.test(id)) return null
    let decoded: unknown
    try { decoded = JSON.parse(Buffer.from(id.slice(5), 'base64url').toString('utf8')) }
    catch { return null }
    if (!decoded || typeof decoded !== 'object') return null
    const { directoryId, relativePath, identity } = decoded as Record<string, unknown>
    if (typeof directoryId !== 'string' || typeof relativePath !== 'string'
      || typeof identity !== 'string' || !/^\d{1,32}\.\d{1,32}\.\d{1,32}$/u.test(identity)) return null
    try {
      return await withDirectory(directoryId, async () => {
        const files = await scope(directoryId)
        if (!files) return null
        const path = await files.locateFile(relativePath, identity)
        return { path, fileIdentity: identity, relativePath, directoryId }
      })
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'not_found', 'forbidden', 'invalid_request', 'conflict'].includes((error as NodeJS.ErrnoException).code ?? '')) return null
      throw error
    }
  }

  async function resolveHostPresentation(path: string, identity: string) {
    if (!isAbsolute(path) || await realpath(path) !== path) throw new DesktopError('not_found', '本机文件已移动或替换')
    const info = await lstat(path, { bigint: true })
    if (!info.isFile() || identityOf(info) !== identity) throw new DesktopError('not_found', '本机文件已移动或替换')
    const beneath = (root: string) => {
      const local = relative(root, path)
      return local && !isAbsolute(local) && local !== '..' && !local.startsWith('..' + sep) ? local.split(sep).join('/') : null
    }
    for (const { id } of await workspaces.list()) {
      const root = await workspaces.get(id).then(workspaces.resolveRoot).catch(error => {
        if (['ENOENT', 'ENOTDIR', 'conflict', 'forbidden', 'not_found'].includes((error as NodeJS.ErrnoException).code ?? '')) return null
        throw error
      })
      const local = root && beneath(root)
      if (local) return (await scope(id))?.preview(local, identity)
    }
    const projectPath = beneath((await workspaces.managedRoots()).project)
    if (!projectPath) return undefined
    const file = await resolveAgentFile('/project/' + projectPath)
    return file?.previewFile.workspaceFile.identity === identity ? file.previewFile : undefined
  }

  async function resolvePresentation(path: string, referenceId?: string) {
    if (referenceId) {
      const reference = await resolveWorkspaceReference(referenceId)
      if (!reference || reference.path !== path) return { error: '引用文件已移动或不可访问' }
      const files = await scope(reference.directoryId)
      const preview = await files?.preview(reference.relativePath, reference.fileIdentity)
      return preview ? { preview } : { error: '引用文件已移动或不可访问' }
    }
    if (isAbsolute(path)) {
      const resolved = await resolveAgentFile(path)
      return resolved ? { preview: resolved.previewFile } : { error: '请使用本轮引用的绝对路径或文件库逻辑路径' }
    }
    if (!path.trim() || /[/\\\x00]/u.test(path)) return { error: '请提供文件名或文件库逻辑路径' }
    const matches = await searchWorkspaces(path, undefined, true)
    if (matches.length > 1) return { error: '文件库中有多个同名文件，请提供准确路径' }
    const reference = matches[0] && await resolveWorkspaceReference(matches[0].id)
    if (!reference) return { error: '找不到唯一匹配的文件，请提供准确路径' }
    const files = await scope(reference.directoryId)
    const preview = await files?.preview(reference.relativePath, reference.fileIdentity)
    return preview ? { preview } : { error: '文件已移动或不可访问' }
  }

  async function execute(command: unknown) {
    if (!command || typeof command !== 'object' || !('action' in command))
      throw new DesktopError('invalid_request', '文件操作无效')
    const path = 'path' in command ? command.path : undefined
    try {
      switch (command.action) {
        case 'workspace-list': return await workspaces.list()
        case 'search':
          {
            const directoryId = 'directoryId' in command ? command.directoryId : undefined
            return await withDirectory(directoryId, () => searchWorkspaces('query' in command ? command.query : undefined, directoryId))
          }
        case 'workspace-add':
        case 'workspace-relink': {
          if (!native) throw new DesktopError('unsupported', '请在桌面应用中选择目录')
          if (command.action === 'workspace-relink' && (!('directoryId' in command) || command.directoryId === undefined))
            throw new DesktopError('invalid_request', '请选择工作区')
          const chosen = await native.pickDirectory()
          return { id: chosen ? await workspaces.bind(chosen, command.action === 'workspace-relink' && 'directoryId' in command ? command.directoryId : undefined) : null }
        }
        case 'workspace-rename':
          await workspaces.rename('directoryId' in command ? command.directoryId : undefined, 'name' in command ? command.name : undefined)
          return { ok: true }
        case 'workspace-remove':
          await workspaces.remove('directoryId' in command ? command.directoryId : undefined)
          return { ok: true }
      }

      const directoryId = 'directoryId' in command ? command.directoryId : undefined
      return await withDirectory(directoryId, async () => {
        const createsProjectDirectory = command.action === 'mkdir' || command.action === 'upload'
          || (command.action === 'reveal' && native !== undefined && path === '')
        const files = await scope(directoryId, createsProjectDirectory)
        if (!files) {
          if (command.action === 'list' && path === '') return []
          throw new DesktopError('not_found', '项目目录尚未创建')
        }
        switch (command.action) {
          case 'list': return await files.list(path, false, true)
          case 'reference': return await files.reference(path)
          case 'mkdir': await mkdir(await files.destination(segments(path))); break
          case 'upload': await files.upload(path, 'data' in command ? command.data : undefined, 'overwrite' in command && command.overwrite === true, 'identity' in command && typeof command.identity === 'string' ? command.identity : undefined); break
          case 'move':
          case 'copy': await files.move(path, 'destination' in command ? command.destination : undefined, command.action === 'copy'); break
          case 'trash': await files.trash(path); break
          case 'download': await files.download(path, 'identity' in command && typeof command.identity === 'string' ? command.identity : undefined); break
          case 'open': {
            if (!native) throw new DesktopError('unsupported', '请使用咕咕桌面应用打开文件')
            const file = await files.locateFile(path, 'identity' in command ? command.identity : undefined)
            if (await native.open(file)) throw new DesktopError('unsupported', '系统无法打开此文件，请检查是否已关联应用')
            break
          }
          case 'reveal':
            if (!native) throw new DesktopError('unsupported', '浏览器预览不支持打开系统目录')
            native.reveal('identity' in command && typeof command.identity === 'string'
              ? await files.locateFile(path, command.identity)
              : await files.locate(segments(path, true)))
            break
          default: throw new DesktopError('invalid_request', '文件操作无效')
        }
        return { ok: true }
      })
    } catch (error) {
      if (error instanceof DesktopError) throw error
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST' || code === 'ENOTEMPTY') throw new DesktopError('conflict', '已有同名文件或文件夹')
      if (code === 'EACCES' || code === 'EPERM') throw new DesktopError('forbidden', '无法访问此文件或目录')
      if (code === 'ENOENT') throw new DesktopError('not_found', '文件或目录不存在')
      throw error
    }
  }
  async function personalDownloadTarget() {
    const root = await workspaces.resolveRoot(await workspaces.get('personal'))
    const identity = identityOf(await lstat(root, { bigint: true }))
    return { root, token: createHash('sha256').update(JSON.stringify([root, identity])).digest('hex') }
  }
  async function agentSaveAttachmentOnce(params: Record<string, unknown>, signal: AbortSignal) {
    const { operationId, fingerprint, attachId, expectedSize, expectedDigest, name, space, projectId, workspaceDirectoryId, folderPath } = params
    if (typeof operationId !== 'string' || !/^[a-f0-9]{64}$/u.test(operationId)
      || typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(fingerprint)
      || typeof attachId !== 'string' || !/^[a-f0-9]{32}$/u.test(attachId)
      || !Number.isSafeInteger(expectedSize) || (expectedSize as number) < 0 || (expectedSize as number) > maxUpload
      || typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedDigest)
      || typeof name !== 'string' || name.length > 300
      || (folderPath !== undefined && (typeof folderPath !== 'string' || folderPath.length > 2048))
      || !['personal', 'project', 'workspace'].includes(String(space))
      || (space === 'project' ? !Number.isSafeInteger(projectId) || (projectId as number) < 1 : projectId !== undefined)
      || (space === 'workspace' ? typeof workspaceDirectoryId !== 'string' || !/^desktop:[a-f0-9-]{36}$/u.test(workspaceDirectoryId)
        : workspaceDirectoryId !== undefined))
      throw new DesktopError('invalid_request', '附件保存参数无效')
    const expectedKeys = ['operationId', 'fingerprint', 'attachId', 'expectedSize', 'expectedDigest', 'name', 'space',
      ...(space === 'project' ? ['projectId'] : []), ...(space === 'workspace' ? ['workspaceDirectoryId'] : []),
      ...(folderPath === undefined ? [] : ['folderPath'])].sort()
    if (Object.keys(params).sort().join(',') !== expectedKeys.join(','))
      throw new DesktopError('invalid_request', '附件保存参数无效')
    const directoryId: DesktopFileDirectory = space === 'project' ? `project:${projectId as number}`
      : space === 'workspace' ? workspaceDirectoryId as DesktopFileDirectory : 'personal'
    const operationRoot = join(protectedRoot ?? root, 'agent-file-save-receipts')
    await mkdir(operationRoot, { recursive: true, mode: 0o700 })
    const receiptPath = join(operationRoot, `${operationId}.json`)
    const sourcePath = join(protectedRoot ?? root, 'agent-attachments', attachId)
    const persist = async (receipt: Record<string, unknown>) => {
      const temp = join(operationRoot, `.gugu-save-${randomUUID()}`)
      try {
        await writeFile(temp, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 })
        await rename(temp, receiptPath)
      } finally { await rm(temp, { force: true }) }
    }
    let receipt: Record<string, unknown> | undefined
    try {
      const raw = JSON.parse(await readFile(receiptPath, 'utf8')) as unknown
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid receipt')
      receipt = raw as Record<string, unknown>
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new DesktopError('storage_error', '附件保存回执无效')
    }
    if (receipt && receipt.fingerprint !== fingerprint) throw new DesktopError('conflict', '附件保存调用参数已变化')
    if (receipt?.status === 'completed' && receipt.result && typeof receipt.result === 'object')
      return { ...receipt.result as Record<string, unknown>, replayed: true }

    const files = await withDirectory(directoryId, () => scope(directoryId, space === 'project'))
    if (!files) throw new DesktopError('not_found', '项目文件目录尚未创建')
    signal.throwIfAborted()
    const source = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    let bytes: Buffer
    try {
      const info = await source.stat()
      if (!info.isFile() || info.size !== expectedSize) throw new DesktopError('not_found', '附件已过期或文件丢失')
      bytes = await source.readFile()
      if (createHash('sha256').update(bytes).digest('hex') !== expectedDigest)
        throw new DesktopError('conflict', '附件内容已变化')
    } finally { await source.close() }
    signal.throwIfAborted()

    const cleanName = basename(name).replace(/[\\/\p{Cc}]/gu, '_').slice(0, 255) || 'attachment.bin'
    const extension = extname(cleanName)
    const stem = extension ? cleanName.slice(0, -extension.length) : cleanName
    const folder = folderPath === undefined ? '' : segments(folderPath).join('/')
    const relativeTarget = (filename: string) => folder ? `${folder}/${filename}` : filename
    let relativePath = typeof receipt?.relativePath === 'string' ? receipt.relativePath : ''
    if (receipt?.status === 'pending' && relativePath) {
      try {
        const existing = await files.read(relativePath)
        try {
          const existingBytes = await existing.handle.readFile()
          if (createHash('sha256').update(existingBytes).digest('hex') === expectedDigest) {
            const result = { name: basename(relativePath), path: relativePath, size_bytes: expectedSize,
              space, ...(space === 'project' ? { project_id: projectId } : {}) }
            await persist({ status: 'completed', fingerprint, result })
            return { ...result, replayed: true }
          }
        } finally { await existing.handle.close() }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT'
          && !(error instanceof DesktopError && error.code === 'not_found')) throw error
      }
    }
    for (let index = 0; index < 1000; index++) {
      signal.throwIfAborted()
      const candidate = `${stem}${index ? ` (${index + 1})` : ''}${extension}`
      const path = relativeTarget(candidate)
      try {
        await files.locateFile(path, undefined)
        continue
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT'
          && !(error instanceof DesktopError && error.code === 'not_found')) throw error
      }
      relativePath = path
      await persist({ status: 'pending', fingerprint, relativePath })
      try {
        await files.writeAtomically(relativePath, async temp => {
          signal.throwIfAborted()
          await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 })
        }, false, undefined, async () => signal.throwIfAborted())
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST'
          || (error instanceof DesktopError && error.code === 'conflict')) continue
        throw error
      }
      const result = { name: candidate, path: relativePath, size_bytes: expectedSize,
        space, ...(space === 'project' ? { project_id: projectId } : {}) }
      await persist({ status: 'completed', fingerprint, result })
      return { ...result, replayed: false }
    }
    throw new DesktopError('conflict', '目标目录中同名文件过多，无法保存附件')
  }
  async function agentSaveAttachment(params: Record<string, unknown>, signal: AbortSignal) {
    const operationId = params.operationId
    if (typeof operationId !== 'string' || !/^[a-f0-9]{64}$/u.test(operationId))
      return agentSaveAttachmentOnce(params, signal)
    const previous = attachmentSaveOperations.get(operationId) ?? Promise.resolve()
    let release = () => {}
    const current = new Promise<void>(resolve => { release = resolve })
    const queued = previous.catch(() => undefined).then(() => current)
    attachmentSaveOperations.set(operationId, queued)
    await previous.catch(() => undefined)
    try { return await agentSaveAttachmentOnce(params, signal) }
    finally {
      release()
      if (attachmentSaveOperations.get(operationId) === queued) attachmentSaveOperations.delete(operationId)
    }
  }
  return {
    execute,
    async agentDownloadTarget() { return (await personalDownloadTarget()).token },
    async agentCommitDownload(dataRoot: string, params: Record<string, unknown>, signal: AbortSignal) {
      const { stage, filename, target } = params
      if (Object.keys(params).length !== 3 || typeof stage !== 'string' || !/^\.gugu-download-[A-Za-z0-9]{6}$/u.test(stage)
        || typeof target !== 'string' || !/^[a-f0-9]{64}$/u.test(target) || segments(filename).length !== 1)
        throw new DesktopError('invalid_request', '下载文件参数无效')
      signal.throwIfAborted()
      const current = await personalDownloadTarget()
      if (current.token !== target) throw new DesktopError('conflict', '个人文件目录已变化')
      const canonical = await realpath(dataRoot)
      const staging = join(canonical, stage)
      const sourcePath = join(staging, 'body')
      const directory = await lstat(staging)
      if (!directory.isDirectory() || directory.isSymbolicLink() || await realpath(staging) !== staging)
        throw new DesktopError('invalid_request', '下载暂存目录无效')
      const source = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
      try {
        const info = await source.stat()
        if (!info.isFile() || info.size > agentDownloadsLimit || await realpath(sourcePath) !== sourcePath)
          throw new DesktopError('invalid_request', '下载暂存文件无效')
        const files = workspaceFiles('personal', async () => current.root)
        try { await mkdir(await files.destination(['下载'])) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
        await files.writeAtomically(`下载/${filename}`, async temp => {
          const output = await open(temp, 'wx', 0o600)
          const body = info.size ? source.createReadStream({ autoClose: false, start: 0, end: info.size - 1 }) : Readable.from([])
          await pipeline(body, output.createWriteStream(), { signal })
        }, false, undefined, async () => {
          signal.throwIfAborted()
          if ((await personalDownloadTarget()).token !== target)
            throw new DesktopError('conflict', '个人文件目录已变化')
          signal.throwIfAborted()
        })
      } finally { await source.close() }
      return null
    },
    agentSaveAttachment,
    async agentOverview() {
      const files = await scope('personal')
      return (await files?.scanOverview())?.overview ?? { total: 0, folders: [], files: [], partial: false }
    },
    async agentProjectFileOverview(id: number, signal: AbortSignal) {
      signal.throwIfAborted()
      const directoryId = `project:${id}`
      return withDirectory(directoryId, async () => {
        const project = await scope(directoryId)
        if (!project) return { total_file_count: 0, root_file_count: 0, total_folder_count: 0 }
        const { counts, incomplete } = await project.scanOverview(signal)
        signal.throwIfAborted()
        if (incomplete) throw new DesktopError('storage_error', '项目文件过多，无法完整统计')
        return counts
      })
    },
    async agentReadSendFile(path: string, signal: AbortSignal, maxBytes = maxUpload) {
      signal.throwIfAborted()
      const resolved = await resolveAgentFile(path)
      if (!resolved) return null
      const source = resolved.previewFile.workspaceFile
      const files = await scope(source.directoryId)
      if (!files) return null
      const { handle, size, type, name } = await files.read(source.relativePath, source.identity)
      try {
        if (!Number.isSafeInteger(size) || size <= 0 || size > maxBytes) return null
        const before = await handle.stat({ bigint: true })
        const bytes = Buffer.alloc(size + 1)
        let offset = 0
        while (offset < bytes.length) {
          signal.throwIfAborted()
          const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
          if (!bytesRead) break
          offset += bytesRead
        }
        const after = await handle.stat({ bigint: true })
        if (offset !== size || after.size !== before.size || after.mtimeNs !== before.mtimeNs) return null
        const extension = extname(name)
        return {
          name: extension ? name.slice(0, -extension.length) : name,
          ext: extension.slice(1).toLowerCase(), mime: type, data: bytes.subarray(0, size),
          async authorize() {
            if (signal.aborted) return false
            try {
              const current = await resolveAgentFile(path)
              return !signal.aborted && current?.root === resolved.root
                && current.previewFile.workspaceFile.identity === source.identity
                && current.previewFile.sizeBytes === size
            } catch (error) {
              if (['ENOENT', 'ENOTDIR', 'not_found', 'forbidden'].includes((error as NodeJS.ErrnoException).code ?? '')) return false
              throw error
            }
          },
        }
      } finally { await handle.close() }
    },
    agentResolveFile: resolveAgentFile,
    resolveWorkspaceReference,
    resolvePresentation,
    globalFileSearch,
    resolveHostPresentation,
    hostPresentationContent(path: string, identity: string, range: string | null, variant?: 'metadata' | 'thumbnail') {
      const url = new URL('gugu-desktop://app/__local-files/content')
      url.searchParams.set('path', basename(path))
      url.searchParams.set('identity', identity)
      if (variant === 'thumbnail') url.searchParams.set('thumbnail', '1')
      return workspaceFiles('personal', () => realpath(dirname(path))).content(url, range, variant === 'metadata')
    },
    async resolveFileForDrag(directoryId: unknown, path: unknown) {
      return withDirectory(directoryId, async () => {
        const files = await scope(directoryId)
        if (!files) throw new DesktopError('not_found', '项目目录尚未创建')
        const entry = await files.locate(segments(path))
        const info = await lstat(entry)
        if (!info.isFile() && !info.isDirectory()) throw new DesktopError('invalid_request', '请选择文件或文件夹')
        return entry
      })
    },
    async personalRoot() { return workspaces.resolveRoot(await workspaces.get('personal')) },
    async content(url: URL, range: string | null) {
      const directoryId = url.searchParams.get('directoryId') ?? undefined
      return withDirectory(directoryId, async () => {
        const files = await scope(directoryId)
        if (!files) throw new DesktopError('not_found', '项目目录尚未创建')
        return files.content(url, range)
      })
    },
  }
}
