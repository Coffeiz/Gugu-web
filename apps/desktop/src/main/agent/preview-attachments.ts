import type { IncomingMessage } from 'node:http'
import { DESKTOP_CHANNELS, MAX_FRAME } from '@gugu/core/desktop'
import { DesktopError } from '../core-host.js'
import type { IpcHandlers } from '../ipc/types.js'

export async function handlePreviewAttachment(req: IncomingMessage, handlers: IpcHandlers) {
  const binary = req.headers['content-type'] === 'application/octet-stream'
  const limit = binary ? 32 * 1024 * 1024 : MAX_FRAME / 2
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
    if (binary) {
      const name = req.headers['x-gugu-attachment-name']
      const mime = req.headers['x-gugu-attachment-type']
      if (typeof name !== 'string' || typeof mime !== 'string') throw new Error()
      command = { action: 'upload', name: decodeURIComponent(name), mime: decodeURIComponent(mime) || null,
        voice: req.headers['x-gugu-attachment-voice'] === '1', data: body }
    } else {
      const parsed = JSON.parse(body.toString('utf8'))
      if (parsed?.action !== 'download' && parsed?.action !== 'deleteDraft') throw new Error()
      command = { action: parsed.action, attachId: parsed.attachId }
    }
  } catch { throw new DesktopError('invalid_request', '预览附件操作无效') }
  const result = await handlers[DESKTOP_CHANNELS.agentAttachment]!(command)
  if (result && typeof result === 'object' && 'data' in result && result.data instanceof Uint8Array) {
    return { ...result, data: Buffer.from(result.data).toString('base64') }
  }
  return result
}
