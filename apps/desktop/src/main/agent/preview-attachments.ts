import type { IncomingMessage } from 'node:http'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DESKTOP_CHANNELS, MAX_FRAME } from '@gugu/core/desktop'
import { CHAT_ATTACHMENT_STAGING_BYTES } from '@gugu/core/agent/attachments/staging'
import { DesktopError } from '../core-host.js'
import type { IpcHandlers } from '../ipc/types.js'

/** 预览上传的二进制体不进内存：先落临时文件，再交给主进程流式复制到附件目录。 */
async function spoolBinaryBody(req: IncomingMessage) {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-preview-attachment-'))
  const target = join(directory, 'body')
  let size = 0
  try {
    const handle = await open(target, 'wx', 0o600)
    try {
      // 按块直写文件句柄：createWriteStream({autoClose:false}) 会占住句柄，
      // 之后的 handle.close() 会死锁，这里不用流。
      for await (const chunk of req) {
        size += chunk.length
        if (size > CHAT_ATTACHMENT_STAGING_BYTES) throw new DesktopError('invalid_request', '预览附件请求过大')
        let offset = 0
        while (offset < chunk.length) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null)
          offset += bytesWritten
        }
      }
      await handle.sync()
    } finally { await handle.close().catch(() => undefined) }
    return { directory, target, size }
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

export async function handlePreviewAttachment(req: IncomingMessage, handlers: IpcHandlers) {
  const binary = req.headers['content-type'] === 'application/octet-stream'
  if (binary) {
    const name = req.headers['x-gugu-attachment-name']
    const mime = req.headers['x-gugu-attachment-type']
    if (typeof name !== 'string' || typeof mime !== 'string') throw new DesktopError('invalid_request', '预览附件操作无效')
    const spool = await spoolBinaryBody(req)
    try {
      const result = await handlers[DESKTOP_CHANNELS.agentAttachment]!({
        action: 'upload', name: decodeURIComponent(name), mime: decodeURIComponent(mime) || null,
        voice: req.headers['x-gugu-attachment-voice'] === '1', sourcePath: spool.target,
      })
      if (result && typeof result === 'object' && 'data' in result && result.data instanceof Uint8Array) {
        return { ...result, data: Buffer.from(result.data).toString('base64') }
      }
      return result
    } finally { await rm(spool.directory, { recursive: true, force: true }).catch(() => undefined) }
  }
  const limit = MAX_FRAME / 2
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new DesktopError('invalid_request', '预览附件请求过大')
    chunks.push(chunk)
  }
  const body = Buffer.concat(chunks)
  let command: unknown
  try {
    const parsed = JSON.parse(body.toString('utf8'))
    if (parsed?.action !== 'download' && parsed?.action !== 'deleteDraft') throw new Error()
    command = { action: parsed.action, attachId: parsed.attachId }
  } catch { throw new DesktopError('invalid_request', '预览附件操作无效') }
  const result = await handlers[DESKTOP_CHANNELS.agentAttachment]!(command)
  if (result && typeof result === 'object' && 'data' in result && result.data instanceof Uint8Array) {
    return { ...result, data: Buffer.from(result.data).toString('base64') }
  }
  return result
}
