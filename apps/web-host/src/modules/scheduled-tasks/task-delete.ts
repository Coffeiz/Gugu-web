import type { FastifyInstance } from 'fastify'
import type { UserFromRequest } from '../../app.js'
import { parsePythonInteger, writeRequestMetadata } from '../../http/request.js'
import { ScheduledTaskNotFound } from '@gugu/core/scheduled-task-delete'
import type { createScheduledTaskDeleter } from '@gugu/core/scheduled-task-delete'

export function registerScheduledTaskDelete(app: FastifyInstance, userFromRequest: UserFromRequest, remove: ReturnType<typeof createScheduledTaskDeleter>): void {
  app.delete<{ Params: { taskId: string } }>('/api/v1/scheduled-tasks/:taskId', async (request, reply) => {
    const id = parsePythonInteger(request.params.taskId)
    if (id == null) return reply.code(422).send({ detail: '任务标识无效' })
    try {
      await remove(userFromRequest(request).requestContext.data.ownerId, id, writeRequestMetadata(request).clientId)
      return reply.code(204).send()
    } catch (error) {
      if (error instanceof ScheduledTaskNotFound) return reply.code(404).send({ detail: error.message })
      throw error
    }
  })
}
