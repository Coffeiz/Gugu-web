import { CoreError } from '@gugu/core'
import { createScheduledSendFileTool } from '@gugu/core/tools'
import { createLocalFileTree, UnsafeLocalPathError } from '@gugu/fs/node'
import { ChatAttachmentCapacityError } from '@gugu/core/agent/attachments/staging'
import { mkdtemp, rm, writeFile, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import JSZip from 'jszip'
import { createDiskFileSearchSources } from '../../search/files.js'
import { resolveFileDirectoryRoot } from '../../workspaces/files.js'
import { sandboxTarget } from '../../workspaces/roots.js'
import type { AgentAttachmentUploadOperations } from '../../agent/attachments/upload.js'

export function createWebScheduledAttachmentResources(storageRoot: string,
  downloadAttachment: (owner: string, id: string) => Promise<{
    fileName: string; ext: string; size: number; handle: FileHandle
  }>, remote: {
    open: Parameters<typeof createScheduledSendFileTool>[1]['open']
    stage: AgentAttachmentUploadOperations['stage']
  }, pool: Parameters<typeof createDiskFileSearchSources>[0]) {
  const sources = createDiskFileSearchSources(pool, storageRoot)
  const folders = sources.find(source => source.type === 'folder')
  const files = sources.find(source => source.type === 'file')!

  async function openLibraryFile(owner: string, path: string, signal: AbortSignal) {
    if (!/^\/(?:personal|project|workspace)\//u.test(path) || path.length > 4096) return null
    const [hit] = await files.search(owner, { q: path, queries: [path], mode: 'OR', perType: 1, types: ['file'] }, signal)
    if (!hit) return null
    const { directoryId, relativePath } = hit.path_file
    const directory = typeof directoryId === 'string' && directoryId !== 'personal'
      ? { projectId: Number(directoryId.slice(8)) } : directoryId
    try {
      const root = await resolveFileDirectoryRoot(pool, owner, directory)
      if (sandboxTarget(root) + '/' + relativePath !== path) return null
      signal.throwIfAborted()
      const opened = await createLocalFileTree(storageRoot, root).open(relativePath)
      if (!opened) return null
      const suffix = extname(hit.title)
      return { ...opened, fileName: hit.title.slice(0, hit.title.length - suffix.length), ext: suffix.slice(1) }
    } catch (error) {
      if (error instanceof UnsafeLocalPathError || (error instanceof CoreError && error.code === 'not_found')) return null
      throw error
    }
  }
  const resolve: Parameters<typeof createScheduledSendFileTool>[0] = async (identity, source, signal) => {
    signal.throwIfAborted()
    const owner = identity.ownerId
    if (source.key === 'attach_id') {
      try {
        const opened = await downloadAttachment(owner, source.value)
        try {
          const suffix = `.${opened.ext}`
          const name = opened.fileName.endsWith(suffix) ? opened.fileName.slice(0, -suffix.length) : opened.fileName
          return { attach_id: source.value, name, ext: opened.ext, size_bytes: opened.size }
        } finally { await opened.handle.close() }
      } catch (error) {
        if (error instanceof CoreError && error.code === 'not_found') return { error: '没找到这个附件，可能已经过期了（聊天附件只暂存 7 天）' }
        throw error
      }
    }
    const opened = await openLibraryFile(owner, source.value, signal)
    if (!opened) return { error: '文件不存在或不可访问' }
    try { return { file_path: source.value, name: opened.fileName, ext: opened.ext, size_bytes: opened.size } }
    finally { await opened.handle.close() }
  }
  return {
    openLibraryFile,
    toolForRun(isCurrent: () => Promise<boolean>, allowFolderZip = false) {
      return createScheduledSendFileTool(resolve, {
        open: remote.open,
        async stage(owner, image, name, signal) {
          signal.throwIfAborted()
          const directory = await mkdtemp(join(tmpdir(), 'gugu-scheduled-image-'))
          try {
            const path = join(directory, 'image')
            await writeFile(path, image.bytes, { flag: 'wx', mode: 0o600, signal })
            if (!await isCurrent()) return { error: '定时任务工具授权已失效' }
            signal.throwIfAborted()
            return await remote.stage(owner, { path, name, ext: image.ext, mime: image.mime, size: image.bytes.length, voice: false })
          } catch (error) {
            if (error instanceof ChatAttachmentCapacityError) return { error: error.message }
            throw error
          } finally { await rm(directory, { recursive: true, force: true }).catch(() => undefined) }
        },
      }, allowFolderZip && folders ? async (identity, path, signal) => {
        if (!/^\/(?:personal|project|workspace)\//u.test(path)) return { error: '请提供文件夹的沙盒绝对路径' }
        const owner = identity.ownerId
        const hits = await folders.search(owner, { q: path, queries: [path], mode: 'OR', perType: 2, types: ['folder'] }, signal)
        const hit = hits.find(item => item.path_file.location.value === path)
        if (!hit) return { error: '文件夹不存在或不可访问' }
        const { directoryId, relativePath } = hit.path_file
        const directory = typeof directoryId === 'string' && directoryId !== 'personal'
          ? { projectId: Number(directoryId.slice(8)) } : directoryId
        const root = await resolveFileDirectoryRoot(pool, owner, directory)
        if (sandboxTarget(root) + '/' + relativePath !== path) return { error: '文件夹位置已变化' }
        const tree = createLocalFileTree(storageRoot, root)
        const zip = new JSZip()
        const pending = [relativePath]
        const limit = 16 * 1024 * 1024
        let entries = 0
        let bytes = 0
        for (const parent of pending) {
          signal.throwIfAborted()
          const children = await tree.list(parent)
          if (!children) return { error: '文件夹已移动或无法读取' }
          for (const child of children) {
            signal.throwIfAborted()
            if (++entries > 1000 || /[\\\p{Cc}]/u.test(child.name)) return { error: '文件夹条目过多或名称无效' }
            const name = child.relativePath.slice(relativePath.length + 1)
            if (child.kind === 'directory') {
              zip.folder(name)
              pending.push(child.relativePath)
              continue
            }
            const opened = await tree.open(child.relativePath)
            if (!opened) return { error: '文件已移动或无法读取' }
            try {
              const room = limit - bytes
              if (opened.size > room) return { error: '文件夹超过 16 MiB 打包上限' }
              const buffer = Buffer.alloc(opened.size + 1)
              const { bytesRead } = await opened.handle.read(buffer, 0, buffer.length, 0)
              if (bytesRead !== opened.size) return { error: '打包期间文件发生变化，请重试' }
              bytes += bytesRead
              zip.file(name, buffer.subarray(0, bytesRead))
            } finally { await opened.handle.close() }
          }
        }
        const archive = await zip.generateAsync({ type: 'nodebuffer' })
        if (archive.length > limit || !await isCurrent()) return { error: 'ZIP 超过大小上限或授权已失效' }
        const staging = await mkdtemp(join(tmpdir(), 'gugu-send-folder-'))
        try {
          const file = join(staging, 'folder.zip')
          await writeFile(file, archive, { flag: 'wx', mode: 0o600, signal })
          if (!await isCurrent()) return { error: '文件夹投递授权已失效' }
          const result = await remote.stage(owner, { path: file, name: hit.title, ext: 'zip', mime: 'application/zip', size: archive.length, voice: false })
          return { attach_id: result.attach_id, name: hit.title, ext: 'zip', size_bytes: archive.length }
        } finally { await rm(staging, { recursive: true, force: true }) }
      } : undefined)
    },
    async read(owner: string, raw: unknown, limit: (ext: string) => number, signal: AbortSignal) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
      const artifact = raw as Record<string, unknown>
      let opened: Awaited<ReturnType<typeof downloadAttachment>> | null
      if (typeof artifact.file_path === 'string') {
        opened = await openLibraryFile(owner, artifact.file_path, signal)
      } else if (typeof artifact.attach_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(artifact.attach_id)) {
        opened = await downloadAttachment(owner, artifact.attach_id)
      } else return null
      if (!opened) return null
      try {
        const ext = opened.ext.toLowerCase().replace(/[^a-z0-9]/gu, '')
        if (opened.size > limit(ext)) return null
        const bytes = new Uint8Array(opened.size + 1)
        let offset = 0
        while (offset < bytes.length) {
          signal.throwIfAborted()
          const { bytesRead } = await opened.handle.read(bytes, offset, Math.min(65536, bytes.length - offset), offset)
          if (!bytesRead) break
          offset += bytesRead
        }
        if (offset !== opened.size) return null
        const label = typeof artifact.name === 'string' ? artifact.name : opened.fileName
        const name = [...label.replace(/[\\/\p{Cc}]/gu, '_').trim()].slice(0, 180).join('') || 'attachment'
        const filename = ext && !name.toLowerCase().endsWith(`.${ext}`) ? `${name}.${ext}` : name
        return { bytes: bytes.subarray(0, offset), ext, filename }
      } finally { await opened.handle.close() }
    },
  }
}
