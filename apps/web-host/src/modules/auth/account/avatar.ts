import '@fastify/multipart'
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { PublicUserRecord } from '../session/token.js'

import { AVATAR_MAX_BYTES, InvalidAvatarError, isAvatarMediaType, setAvatar, type AvatarMediaType } from '@gugu/users'

export interface UserAvatarImage {
  readonly data: Buffer
  readonly mediaType: AvatarMediaType
}

export interface UserAvatarOperations {
  upload(ownerId: string, mediaType: AvatarMediaType, data: Buffer): Promise<PublicUserRecord>
  read(userId: string): Promise<UserAvatarImage | null>
}

export interface UserAvatarUploadRouteOptions {
  readonly requireUser: preHandlerHookHandler
  readonly ownerIdFromRequest: (request: FastifyRequest) => string
  readonly operations: UserAvatarOperations
}

export function registerUserAvatarReadRoute(app: FastifyInstance, operations: UserAvatarOperations): void {
  app.get<{ Params: { user_id: string } }>('/api/v1/users/:user_id/avatar', async (request, reply) => {
    const userId = request.params.user_id
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
      return reply.code(422).send({ detail: '用户 ID 无效' })
    }
    const image = await operations.read(userId.toLowerCase())
    if (!image) return reply.code(404).send({ detail: '头像不存在' })
    return reply
      .type(image.mediaType)
      .header('cache-control', 'no-cache')
      .send(image.data)
  })
}

export function registerUserAvatarUploadRoute(
  app: FastifyInstance,
  options: UserAvatarUploadRouteOptions,
): void {
  const routeOptions = { preHandler: options.requireUser }
  app.put('/api/v1/users/me/avatar', routeOptions, upload)

  async function upload(request: FastifyRequest, reply: FastifyReply) {
    const part = await request.file({
      limits: { files: 1, fields: 0, parts: 1, fileSize: AVATAR_MAX_BYTES },
    })
    if (!part || part.fieldname !== 'file') {
      return reply.code(422).send({ detail: '缺少头像文件' })
    }
    if (!isAvatarMediaType(part.mimetype)) {
      part.file.resume()
      return reply.code(400).send({ detail: '仅支持 JPEG/PNG/WebP/GIF 格式' })
    }

    let data: Buffer
    try {
      data = await part.toBuffer()
    } catch (error) {
      if (part.file.truncated) return reply.code(400).send({ detail: '头像文件不能超过 5MB' })
      throw error
    }
    if (part.file.truncated || data.length > AVATAR_MAX_BYTES) {
      return reply.code(400).send({ detail: '头像文件不能超过 5MB' })
    }

    try {
      return await setAvatar(options.ownerIdFromRequest(request), { mediaType: part.mimetype, data },
        (ownerId, mediaType, bytes) => options.operations.upload(ownerId, mediaType, bytes))
    } catch (error) {
      if (error instanceof InvalidAvatarError) return reply.code(400).send({ detail: error.message })
      throw error
    }
  }
}
