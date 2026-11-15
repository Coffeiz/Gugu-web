import type { FastifyInstance } from 'fastify'
import type { NotificationOptions, UserFromRequest } from '../../../app.js'
import { validateDto } from '../../../http/dto.js'
import { notificationReadBodySchema } from '../../../http/dtos.js'

function notificationLimit(query: Record<string, unknown>): number | null {
  const value = query.limit
  if (value === undefined) return 30
  if (typeof value !== 'string') return null

  // FastAPI 将 query 字符串交给 int()；保留其正负号/空白解析和 service 的 1..100 范围。
  const normalized = value.trim()
  if (!/^[+-]?\d+$/.test(normalized)) return null
  const parsed = BigInt(normalized)
  if (parsed < 1n) return 1
  if (parsed > 100n) return 100
  return Number(parsed)
}

function userCreatedAt(user: ReturnType<UserFromRequest>): Date | string {
  if (!user.createdAt) throw new Error('用户注册时间缺失')
  return user.createdAt
}

export function registerNotificationRoutes(
  app: FastifyInstance,
  userFromRequest: UserFromRequest,
  notifications: NotificationOptions,
): void {
  app.get('/api/v1/notifications', async (request, reply) => {
    const user = userFromRequest(request)
    const limit = notificationLimit(request.query as Record<string, unknown>)
    if (limit === null) return reply.code(422).send({ detail: 'limit 必须是整数' })
    return notifications.list(user.id, userCreatedAt(user), limit)
  })

  app.get('/api/v1/notifications/bubble', async (request) => {
    const user = userFromRequest(request)
    return notifications.latestBubble(user.id, userCreatedAt(user))
  })

  app.post('/api/v1/notifications/read', async (request, reply) => {
    const user = userFromRequest(request)
    const result = validateDto(notificationReadBodySchema, request.body)
    if (!result.ok) return reply.code(422).send({ detail: '通知已读请求无效' })
    const marked = await notifications.markRead(user.id, userCreatedAt(user), result.value)
    return { ok: true, marked }
  })

  app.delete('/api/v1/notifications', async (request) => {
    const user = userFromRequest(request)
    const dismissed = await notifications.clear(user.id, userCreatedAt(user))
    return { ok: true, dismissed }
  })
}
