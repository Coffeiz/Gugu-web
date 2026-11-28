import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DESKTOP_CHANNELS, type DesktopAgentAttachment, type DesktopAgentAttachmentCommand } from '@gugu/core/desktop'
import { CHAT_ATTACHMENT_AUDIO_MATERIALIZE_BYTES, CHAT_ATTACHMENT_STAGING_BYTES, parseChatAttachmentFilename } from '@gugu/core/agent/attachments/staging'
import { ATTACHMENT_MAX_BYTES } from '@gugu/core/agent/attachments/limits'
import { DesktopError } from '../core-host.js'
import type { IpcHandlers, IpcHost } from '../ipc/types.js'

import type { createDesktopRecordingTranscriber } from './voice-recording.js'

/**
 * 单文件附件/文件库准入上限（100 MB，来自 core 的 ATTACHMENT_MAX_BYTES，与 IM 媒体预算一致）。
 * 只有「整块字节」这条 IPC 路径会按此校验，且内存开销与文件大小同阶，优先走
 * sourcePath 流式落盘；聊天暂存总容量另由 CHAT_ATTACHMENT_STAGING_BYTES 约束。
 */
export const MAX_DESKTOP_ATTACHMENT_BYTES = ATTACHMENT_MAX_BYTES

function attachmentRoot(dataDirectory: string) { return resolve(dataDirectory, 'agent-attachments') }

export async function writeDesktopAgentAttachment(dataDirectory: string, attachId: string, bytes: Uint8Array, maxBytes = MAX_DESKTOP_ATTACHMENT_BYTES) {
  if (!/^[0-9a-f]{32}$/.test(attachId) || bytes.byteLength > maxBytes)
    throw new DesktopError('invalid_request', '附件写入信息无效')
  const root = attachmentRoot(dataDirectory)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new DesktopError('storage_error', '附件存储目录不可用')
  const target = join(await realpath(root), attachId)
  const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
  try {
    try { await handle.writeFile(bytes); await handle.sync() }
    finally { await handle.close() }
    return target
  } catch (error) {
    await rm(target, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * 从本机源路径流式复制附件：文件不整块进内存，也不受 IPC 传输上限约束。
 * 源文件由用户在文件选择器里挑定，符号链接按用户意图跟随，但必须是普通文件。
 */
export async function writeDesktopAgentAttachmentFromPath(dataDirectory: string, attachId: string, sourcePath: string) {
  if (!/^[0-9a-f]{32}$/.test(attachId) || typeof sourcePath !== 'string' || !sourcePath.trim())
    throw new DesktopError('invalid_request', '附件写入信息无效')
  let source
  try { source = await open(sourcePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)) }
  catch { throw new DesktopError('invalid_request', '附件来源不可读') }
  try {
    const info = await source.stat()
    if (!info.isFile()) throw new DesktopError('invalid_request', '附件来源不是普通文件')
    if (info.size > CHAT_ATTACHMENT_STAGING_BYTES) throw new DesktopError('invalid_request', '附件超过暂存容量上限')
    const root = attachmentRoot(dataDirectory)
    await mkdir(root, { recursive: true, mode: 0o700 })
    const rootInfo = await lstat(root)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
      throw new DesktopError('storage_error', '附件存储目录不可用')
    const target = join(await realpath(root), attachId)
    const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    try {
      try {
        // 不用 FileHandle.createWriteStream：autoClose:false 会让写流一直占着句柄，
        // 随后的 handle.close() 会一直等下去（死锁）。这里按块读写，内存占用固定。
        const buffer = Buffer.allocUnsafe(1024 * 1024)
        let written = 0
        for (;;) {
          const { bytesRead } = await source.read(buffer, 0, buffer.length, null)
          if (!bytesRead) break
          written += bytesRead
          if (written > CHAT_ATTACHMENT_STAGING_BYTES) throw new DesktopError('invalid_request', '附件超过暂存容量上限')
          let offset = 0
          while (offset < bytesRead) {
            const { bytesWritten } = await handle.write(buffer, offset, bytesRead - offset, null)
            offset += bytesWritten
          }
        }
        await handle.sync()
      } finally { await handle.close().catch(() => undefined) }
      return target
    } catch (error) {
      await rm(target, { force: true }).catch(() => undefined)
      throw error
    }
  } finally { await source.close().catch(() => undefined) }
}

export async function removeDesktopAgentAttachmentFiles(dataDirectory: string, attachIds: readonly string[]): Promise<void> {
  const root = attachmentRoot(dataDirectory)
  for (const attachId of new Set(attachIds)) {
    if (!/^[0-9a-f]{32}$/.test(attachId)) continue
    await rm(join(root, attachId), { force: true }).catch(() => undefined)
  }
}

export async function readDesktopAgentAttachment(host: IpcHost, dataDirectory: string, attachId: string, maxBytes = MAX_DESKTOP_ATTACHMENT_BYTES) {
  if (!/^[0-9a-f]{32}$/.test(attachId)) throw new DesktopError('invalid_request', '附件标识无效')
  const attachment = await host.request<DesktopAgentAttachmentMetadata>('agent.attachments.download', { attach_id: attachId })
  return readDesktopAgentAttachmentContent(dataDirectory, attachId, attachment, maxBytes)
}

type DesktopAgentAttachmentMetadata = { storageKey: string; name: string; ext: string; mime: string | null; size: number }
export async function readDesktopAgentAttachmentContent(dataDirectory: string, attachId: string,
  attachment: DesktopAgentAttachmentMetadata, maxBytes = MAX_DESKTOP_ATTACHMENT_BYTES) {
  if (!/^[0-9a-f]{32}$/.test(attachId)) throw new DesktopError('invalid_request', '附件标识无效')
  const root = attachmentRoot(dataDirectory)
  if (attachment.storageKey !== `agent-attachments/${attachId}`
    || typeof attachment.name !== 'string' || attachment.name.length > 255
    || typeof attachment.ext !== 'string' || attachment.ext.length > 16
    || (attachment.mime !== null && typeof attachment.mime !== 'string')
    || !Number.isSafeInteger(attachment.size) || attachment.size < 0 || attachment.size > CHAT_ATTACHMENT_STAGING_BYTES)
    throw new DesktopError('not_found', '附件不存在或已过期')
  if (attachment.size > maxBytes) throw new DesktopError('invalid_request', `附件超过 ${Math.floor(maxBytes / (1024 * 1024))}MB 读取上限`)
  const rootInfo = await lstat(root).catch(() => null)
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink())
    throw new DesktopError('not_found', '附件不存在或已过期')
  const target = join(await realpath(root), attachId)
  let handle
  try {
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const info = await handle.stat()
    if (!info.isFile() || info.size !== attachment.size || info.size > CHAT_ATTACHMENT_STAGING_BYTES)
      throw new DesktopError('not_found', '附件不存在或已过期')
    const data = await handle.readFile()
    if (data.byteLength !== attachment.size) throw new DesktopError('not_found', '附件不存在或已过期')
    return { name: `${attachment.name}${attachment.ext ? `.${attachment.ext}` : ''}`,
      mime: typeof attachment.mime === 'string' && attachment.mime ? attachment.mime : 'application/octet-stream',
      displayName: attachment.name, ext: attachment.ext, data: new Uint8Array(data) }
  } catch (error) {
    if (error instanceof DesktopError) throw error
    throw new DesktopError('not_found', '附件不存在或已过期')
  } finally { await handle?.close().catch(() => undefined) }
}

export function desktopAgentAttachmentHandlers(host: IpcHost, dataDirectory: string,
  transcribe?: ReturnType<typeof createDesktopRecordingTranscriber>,
): IpcHandlers {
  const root = attachmentRoot(dataDirectory)
  async function removeFile(attachId: string) {
    if (!/^[0-9a-f]{32}$/.test(attachId)) return
    const info = await lstat(root).catch(() => null)
    if (!info?.isDirectory() || info.isSymbolicLink()) return
    const target = join(await realpath(root), attachId)
    await rm(target, { force: true })
  }
  return {
    [DESKTOP_CHANNELS.agentAttachment]: async (...args: unknown[]) => {
      const command = args[0] as DesktopAgentAttachmentCommand
      if (!command || typeof command !== 'object') throw new DesktopError('invalid_request', '附件操作无效')
      if (command.action === 'deleteDraft') {
        if (!/^[0-9a-f]{32}$/.test(command.attachId)) throw new DesktopError('invalid_request', '附件标识无效')
        const key = await host.request<string | null>('agent.attachments.deleteDraft', { attach_id: command.attachId })
        if (key === `agent-attachments/${command.attachId}`) await removeFile(command.attachId)
        return null
      }
      if (command.action === 'download') return readDesktopAgentAttachment(host, dataDirectory, command.attachId)
      const sourcePath = typeof command.sourcePath === 'string' && command.sourcePath.trim() ? command.sourcePath : undefined
      const data = command.data instanceof Uint8Array ? command.data : undefined
      if (command.action !== 'upload' || typeof command.name !== 'string'
        || (command.mime !== null && typeof command.mime !== 'string') || typeof command.voice !== 'boolean'
        || (!sourcePath && !data) || (data && data.byteLength > MAX_DESKTOP_ATTACHMENT_BYTES))
        throw new DesktopError('invalid_request', '附件上传信息无效')
      const { name, ext } = parseChatAttachmentFilename(command.name)
      if (name.length > 255 || ext.length > 16)
        throw new DesktopError('invalid_request', '附件文件名超出限制')
      const attachId = randomUUID().replaceAll('-', '')
      let target: string | undefined
      let bytes: Uint8Array | undefined = data
      try {
        let size: number
        if (sourcePath) {
          target = await writeDesktopAgentAttachmentFromPath(dataDirectory, attachId, sourcePath)
          size = (await lstat(target)).size
          // 语音转写要整字节：只在这条流式路径上读回，且受音频物化上限约束。
          if (command.voice && size <= CHAT_ATTACHMENT_AUDIO_MATERIALIZE_BYTES)
            bytes = new Uint8Array(await readFile(target))
        } else {
          // 整块字节这条路同样要落盘：32MB 只是 IPC 传输上限，不是附件大小上限。
          target = await writeDesktopAgentAttachment(dataDirectory, attachId, data!)
          size = data!.byteLength
        }
        let transcription
        if (command.voice) {
          if (!transcribe) throw new DesktopError('model_unavailable', '语音转写不可用')
          if (ext.toLowerCase() !== 'wav' || command.mime !== 'audio/wav')
            throw new DesktopError('invalid_request', '录音格式无效')
          if (size > CHAT_ATTACHMENT_AUDIO_MATERIALIZE_BYTES)
            throw new DesktopError('invalid_request', `语音录音过大（上限 ${Math.floor(CHAT_ATTACHMENT_AUDIO_MATERIALIZE_BYTES / (1024 * 1024))}MB），请分段录制后再发送`)
          if (!bytes) throw new DesktopError('invalid_request', '录音内容无效')
          transcription = await transcribe(bytes)
        }
        return await host.request<DesktopAgentAttachment>('agent.attachments.stage', {
          attachment: { attachId, name: name || 'file', ext: ext.toLowerCase(), mime: command.mime,
            size, voice: command.voice, ...transcription },
        })
      } catch (error) {
        if (target) await rm(target, { force: true }).catch(() => undefined)
        if (error instanceof DesktopError) throw error
        throw new DesktopError('storage_error', '附件保存失败，请重试')
      }
    },
  }
}
