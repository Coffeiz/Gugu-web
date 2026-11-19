import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'

export interface AttachmentDraftDeleteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  remove(ownerId: string, attachmentId: string): Promise<{ deleted: true }>
}

/** Fastify 只绑定已认证身份并映射 Core 回执，草稿状态与清理由 Core/存储端口处理。 */
export function registerAttachmentDraftDeleteRoute(app: FastifyInstance, options: AttachmentDraftDeleteOptions): void {
  app.delete<{ Params: { attach_id: string } }>('/api/v1/agent/attachment/:attach_id', {
    preHandler: options.requireUser,
  }, async (request, reply) => reply.send(await options.remove(
    options.ownerIdFromRequest(request), request.params.attach_id,
  )))
}
