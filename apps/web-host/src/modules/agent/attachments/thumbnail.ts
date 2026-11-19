import { createCanvas, loadImage } from '@napi-rs/canvas'
import { planAttachmentThumbnail } from '@gugu/core/files/read'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { AttachmentDownloadOptions } from './download.js'

export interface AttachmentThumbnailOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  download: AttachmentDownloadOptions['download']
}

export function registerAttachmentThumbnailRoute(app: FastifyInstance, options: AttachmentThumbnailOptions): void {
  app.get<{ Params: { attach_id: string } }>('/api/v1/agent/attachment/:attach_id/thumb', {
    preHandler: options.requireUser,
  }, async (request, reply) => {
    const source = await options.download(options.ownerIdFromRequest(request), request.params.attach_id)
    try {
      const plan = planAttachmentThumbnail({
        kind: source.kind ?? null,
        ext: source.ext ?? '',
        mimeType: source.mimeType,
        qqFace: Boolean(source.qqFace),
        size: typeof (request.query as Record<string, unknown>).size === 'string'
          ? String((request.query as Record<string, unknown>).size)
          : 'card',
      })
      if (!plan) return reply.code(404).send({ detail: '附件不存在或不是图片' })
      const raw = await source.handle.readFile()
      let content: Uint8Array = raw
      let mimeType = source.mimeType || 'application/octet-stream'
      if (plan.kind === 'raw') mimeType = plan.mimeType
      else {
        try {
          const image = await loadImage(raw)
          const scale = Math.min(1, plan.maxDimension / Math.max(image.width, image.height))
          const width = Math.max(1, Math.round(image.width * scale))
          const height = Math.max(1, Math.round(image.height * scale))
          const canvas = createCanvas(width, height)
          canvas.getContext('2d').drawImage(image, 0, 0, width, height)
          content = canvas.toBuffer('image/jpeg', plan.quality)
          mimeType = plan.mimeType
        } catch {
          // 对无法解码或无法渲染的图片，按旧 Python 服务行为返回原内容。
        }
      }
      return reply.type(mimeType).header('Cache-Control', 'private, max-age=3600').send(content)
    } finally {
      await source.handle.close()
    }
  })
}
