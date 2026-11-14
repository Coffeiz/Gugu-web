import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import type { FeedbackOptions, UserFromRequest } from '../../app.js'
import { validateDto } from '../../http/dto.js'
import { feedbackCreateBodySchema } from '../../http/dtos.js'

export function registerFeedbackRoute(
  app: FastifyInstance,
  userFromRequest: UserFromRequest,
  feedback: FeedbackOptions,
): void {
  app.post('/api/v1/feedback', async (request, reply) => {
    const user = userFromRequest(request)
    const result = validateDto(feedbackCreateBodySchema, request.body)
    if (!result.ok) return reply.code(422).send({ detail: '反馈请求字段无效' })
    if (!['bug', 'suggestion', 'other'].includes(result.value.category))
      return reply.code(400).send({ detail: '无效分类' })
    const content = result.value.content.trim()
    if (!content) return reply.code(400).send({ detail: '反馈内容不能为空' })
    await feedback.submit(user.id, user.displayName || user.username, result.value.category, content)
    return reply.code(201).send({ ok: true })
  })
}

export interface AdminFeedbackOperations {
  list(page: number, pageSize: number, category: string): Promise<{ total: number; items: unknown[] }>
}

export function registerAdminFeedbackRoute(
  app: FastifyInstance,
  requireAdmin: preHandlerHookHandler,
  feedback: AdminFeedbackOperations,
): void {
  app.get('/api/v1/admin/feedback', { preHandler: requireAdmin }, async (request, reply) => {
    const query = request.query as { page?: string; page_size?: string; category?: string }
    const page = parsePositiveInteger(query.page, 1)
    const pageSize = parsePositiveInteger(query.page_size, 30)
    if (page === null || pageSize === null) return reply.code(422).send({ detail: '分页参数无效' })
    return feedback.list(page, pageSize, query.category ?? '')
  })
}

function parsePositiveInteger(value: string | undefined, fallback: number): number | null {
  if (value === undefined) return fallback
  if (!/^[+-]?\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}
