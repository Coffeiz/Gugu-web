import { CoreError } from '@gugu/core'
import type { SqlDataRuntime } from '@gugu/core/data'
import { createPostgresSendFileLookup, createScheduledSendFileTool } from '@gugu/core/tools'
import { openLocalFile, UnsafeLocalPathError } from '@gugu/fs/node'
import { ChatAttachmentCapacityError } from '@gugu/core/agent/attachments/staging'
import { mkdtemp, rm, writeFile, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentAttachmentUploadOperations } from '../../agent/attachments/upload.js'
import { isOwnedFileStorageKey } from '../../files/store.js'

export function createWebScheduledAttachmentResources(core: SqlDataRuntime, storageRoot: string,
  downloadAttachment: (owner: string, id: string) => Promise<{
    fileName: string; ext: string; size: number; handle: FileHandle
  }>, remote: {
    open: Parameters<typeof createScheduledSendFileTool>[1]['open']
    stage: AgentAttachmentUploadOperations['stage']
  }) {
  const lookup = createPostgresSendFileLookup(core.db)
  async function openLibraryFile(owner: string, file: Awaited<ReturnType<typeof lookup>>[number] | undefined) {
    if (!file || file.storage_backend !== 'local' || typeof file.storage_key !== 'string'
      || !isOwnedFileStorageKey(owner, file.storage_key)) return null
    try { return await openLocalFile(storageRoot, file.storage_key) }
    catch (error) { if (error instanceof UnsafeLocalPathError) return null; throw error }
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
    const matches = await lookup(owner, source)
    if (matches.length > 1) return { error: '有多个匹配文件，请用 file_id 指明',
      candidates: matches.map(row => ({ id: row.id, name: row.ext ? `${row.display_name}.${row.ext}` : row.display_name,
        space: row.space, folder_id: row.folder_id })) }
    const file = matches[0]
    if (!file) return { error: '文件不存在' }
    signal.throwIfAborted()
    const opened = await openLibraryFile(owner, file)
    if (!opened) return { error: '文件不存在' }
    try { return { file_id: file.id, name: file.display_name, ext: file.ext ?? '', size_bytes: opened.size } }
    finally { await opened.handle.close() }
  }
  return {
    toolForRun(isCurrent: () => Promise<boolean>) {
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
      })
    },
    async read(owner: string, raw: unknown, limit: (ext: string) => number, signal: AbortSignal) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
      const artifact = raw as Record<string, unknown>
      const id = artifact.file_id
      let opened: Awaited<ReturnType<typeof downloadAttachment>> | null
      if (typeof id === 'number' && Number.isInteger(id) && id > 0 && id <= 2_147_483_647) {
        const [file] = await lookup(owner, { key: 'file_id', value: id })
        const local = await openLibraryFile(owner, file)
        opened = file && local ? { ...local, fileName: file.display_name, ext: file.ext ?? '' } : null
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
