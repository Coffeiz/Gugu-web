import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DESKTOP_CHANNELS, type DesktopAgentAttachment, type DesktopAgentAttachmentCommand } from '@gugu/core/desktop'
import { parseChatAttachmentFilename } from '@gugu/core/agent/attachments/staging'
import { DesktopError } from '../core-host.js'
import type { IpcHandlers, IpcHost } from '../ipc/types.js'

import type { createDesktopRecordingTranscriber } from './voice-recording.js'

export const MAX_DESKTOP_ATTACHMENT_BYTES = 32 * 1024 * 1024

export async function writeDesktopAgentAttachment(dataDirectory: string, attachId: string, bytes: Uint8Array) {
  if (!/^[0-9a-f]{32}$/.test(attachId) || bytes.byteLength > MAX_DESKTOP_ATTACHMENT_BYTES)
    throw new DesktopError('invalid_request', '附件写入信息无效')
  const root = resolve(dataDirectory, 'agent-attachments')
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

export async function removeDesktopAgentAttachmentFiles(dataDirectory: string, attachIds: readonly string[]): Promise<void> {
  const root = resolve(dataDirectory, 'agent-attachments')
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
  const root = resolve(dataDirectory, 'agent-attachments')
  if (attachment.storageKey !== `agent-attachments/${attachId}`
    || typeof attachment.name !== 'string' || attachment.name.length > 255
    || typeof attachment.ext !== 'string' || attachment.ext.length > 16
    || (attachment.mime !== null && typeof attachment.mime !== 'string')
    || !Number.isSafeInteger(attachment.size) || attachment.size < 0 || attachment.size > MAX_DESKTOP_ATTACHMENT_BYTES)
    throw new DesktopError('not_found', '附件不存在或已过期')
  if (attachment.size > maxBytes) throw new DesktopError('invalid_request', '图片超过相似图搜索的 4MB 限制')
  const rootInfo = await lstat(root).catch(() => null)
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink())
    throw new DesktopError('not_found', '附件不存在或已过期')
  const target = join(await realpath(root), attachId)
  let handle
  try {
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const info = await handle.stat()
    if (!info.isFile() || info.size !== attachment.size || info.size > MAX_DESKTOP_ATTACHMENT_BYTES)
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
  const root = resolve(dataDirectory, 'agent-attachments')
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
      if (command.action !== 'upload' || typeof command.name !== 'string'
        || (command.mime !== null && typeof command.mime !== 'string') || typeof command.voice !== 'boolean'
        || !(command.data instanceof Uint8Array) || command.data.byteLength > MAX_DESKTOP_ATTACHMENT_BYTES)
        throw new DesktopError('invalid_request', '附件上传信息无效')
      const { name, ext } = parseChatAttachmentFilename(command.name)
      if (name.length > 255 || ext.length > 16)
        throw new DesktopError('invalid_request', '附件文件名超出限制')
      let transcription
      if (command.voice) {
        if (!transcribe) throw new DesktopError('model_unavailable', '语音转写不可用')
        if (ext.toLowerCase() !== 'wav' || command.mime !== 'audio/wav')
          throw new DesktopError('invalid_request', '录音格式无效')
        transcription = await transcribe(command.data)
      }
      const attachId = randomUUID().replaceAll('-', '')
      let target: string | undefined
      try {
        target = await writeDesktopAgentAttachment(dataDirectory, attachId, command.data)
        return await host.request<DesktopAgentAttachment>('agent.attachments.stage', {
          attachment: { attachId, name: name || 'file', ext: ext.toLowerCase(), mime: command.mime,
            size: command.data.byteLength, voice: command.voice, ...transcription },
        })
      } catch (error) {
        if (target) await rm(target, { force: true }).catch(() => undefined)
        if (error instanceof DesktopError) throw error
        throw new DesktopError('storage_error', '附件保存失败，请重试')
      }
    },
  }
}
