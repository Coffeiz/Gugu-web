import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { CoreError } from '@gugu/core'
import { parseChatAttachmentFilename } from '@gugu/core/agent/attachments/staging'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'

export interface AgentAttachmentUploadInput {
  path: string
  name: string
  ext: string
  mime: string | null
  size: number
  voice: boolean
}

export interface AgentAttachmentUploadOperations {
  capacity(ownerId: string): Promise<number>
  stage(ownerId: string, input: AgentAttachmentUploadInput): Promise<{
    attach_id: string; name: string; ext: string; size: number; kind: string
    duration: number | null; img_width: number | null; img_height: number | null; qq_face: boolean | null
  }>
}

export interface AgentAttachmentUploadRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  operations: AgentAttachmentUploadOperations
  tempDirectory?: string
}

const CAPACITY_ERROR = '聊天附件暂存空间已满，请先清理旧附件后再试'
function tooLarge(detail: string): Error {
  return Object.assign(new Error(detail), { statusCode: 413 })
}

function voiceValue(value: string): boolean | null {
  switch (value.trim().toLowerCase()) {
    case '1': case 'true': case 'yes': case 'y': case 'on': return true
    case '0': case 'false': case 'no': case 'n': case 'off': return false
    default: return null
  }
}

/** 接收 multipart 与流式临时文件；容量、媒体处理和草稿事务由注入的业务服务完成。 */
export function registerAgentAttachmentUploadRoute(app: FastifyInstance, options: AgentAttachmentUploadRouteOptions): void {
  app.post('/api/v1/agent/upload', { preHandler: options.requireUser }, async (request, reply) => {
    const ownerId = options.ownerIdFromRequest(request)
    const remaining = await options.operations.capacity(ownerId)
    if (!Number.isSafeInteger(remaining) || remaining < 0) throw new Error('附件暂存容量读取失败')

    let temp: string | null = null
    let uploaded: { path: string; filename: string; mimetype: string; size: number } | null = null
    let voice = false
    let invalidVoice = false
    try {
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          if (uploaded) throw new CoreError('invalid_request', '只能上传一个附件')
          const directory = await mkdtemp(path.join(options.tempDirectory ?? tmpdir(), 'gugu-attachment-'))
          temp = directory
          const destination = path.join(directory, 'upload')
          let size = 0
          const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
            size += chunk.length
            if (size > remaining) { callback(tooLarge(CAPACITY_ERROR)); return }
            callback(null, chunk)
          } })
          await pipeline(part.file, limit, createWriteStream(destination, { flags: 'wx', mode: 0o600 }))
          if (part.file.truncated) throw tooLarge(CAPACITY_ERROR)
          uploaded = { path: destination, filename: part.filename, mimetype: part.mimetype, size }
        } else if (part.fieldname === 'voice') {
          const value = voiceValue(String(part.value))
          if (value === null) invalidVoice = true
          else voice = value
        }
      }
      if (invalidVoice) throw new CoreError('invalid_request', 'voice 参数无效')
      if (!uploaded) throw new CoreError('invalid_request', '缺少上传文件')
      const { name, ext } = parseChatAttachmentFilename(uploaded.filename)
      return reply.send(await options.operations.stage(ownerId, {
        path: uploaded.path, name, ext, mime: uploaded.mimetype || null, size: uploaded.size, voice,
      }))
    } finally {
      if (temp) await rm(temp, { recursive: true, force: true }).catch(() => undefined)
    }
  })
}
