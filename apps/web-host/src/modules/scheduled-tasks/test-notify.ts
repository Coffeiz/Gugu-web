import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { UserFromRequest } from '../../app.js'
import type { createScheduledTaskTestNotifier } from '@gugu/core/scheduled-task-test-notify'
import { InvalidScheduledTaskDeliveryTarget } from '@gugu/core/scheduled-task-test-notify'

const record = z.record(z.string(), z.unknown()).nullable().optional()
const bodySchema = z.object({
  channels: z.array(z.string()).default(['web']),
  name: z.string().default('活动提醒'),
  qq_delivery: record,
  im_delivery: record,
})

export type ScheduledTaskTestNotifier = ReturnType<typeof createScheduledTaskTestNotifier>

/** Fastify 负责 DTO 和认证上下文，Core 负责旧版消息契约，Host 负责实际渠道投递。 */
export function registerScheduledTaskTestNotify(
  app: FastifyInstance,
  userFromRequest: UserFromRequest,
  notify: ScheduledTaskTestNotifier,
): void {
  app.post('/api/v1/scheduled-tasks/test-notify', async (request, reply) => {
    const parsed = bodySchema.safeParse(request.body)
    if (!parsed.success) return reply.code(422).send({ detail: '测试提醒请求无效' })
    try {
      return await notify(userFromRequest(request).requestContext.data.ownerId, parsed.data)
    } catch (error) {
      if (error instanceof InvalidScheduledTaskDeliveryTarget) return reply.code(400).send({ detail: error.message })
      throw error
    }
  })
}
