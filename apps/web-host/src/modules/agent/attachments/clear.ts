import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'

export interface AttachmentDraftClearOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  clear(ownerId: string): Promise<{ deleted: number }>
}

/** Fastify 负责 HTTP 与认证；Core 协调用例处理草稿行、Local 字节和旧 Redis 元数据。 */
export function registerAttachmentDraftClearRoute(app: FastifyInstance, options: AttachmentDraftClearOptions): void {
  app.delete('/api/v1/agent/attachments', { preHandler: options.requireUser }, async (request, reply) =>
    reply.send(await options.clear(options.ownerIdFromRequest(request))))
}
