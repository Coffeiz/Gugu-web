import type { FastifyInstance } from 'fastify'
import { ScheduledTaskRunNowError } from '@gugu/core/scheduled-task-run-now'
import { parsePythonInteger } from '../../http/request.js'
import type { UserFromRequest } from '../../app.js'

export type ScheduledTaskRunNow = ReturnType<typeof import('@gugu/core/scheduled-task-run-now').createScheduledTaskRunNow>

export function registerScheduledTaskRunNow(app: FastifyInstance, userFromRequest: UserFromRequest, runNow: ScheduledTaskRunNow): void {
  app.post<{ Params: { taskId: string } }>('/api/v1/scheduled-tasks/:taskId/run', async (request, reply) => {
    const id = parsePythonInteger(request.params.taskId)
    if (id == null) return reply.code(422).send({ detail: '任务 ID 无效' })
    try {
      return await runNow(userFromRequest(request).requestContext.data.ownerId, String(id))
    } catch (error) {
      if (error instanceof ScheduledTaskRunNowError && error.code === 'not_found')
        return reply.code(404).send({ detail: '任务不存在' })
      throw error
    }
  })
}
