import type { FastifyInstance } from 'fastify'
import type { UserFromRequest, WebUiOptions, WriteRequestMetadata } from '../../../app.js'
import { queryBoolean, writeRequestMetadata } from '../../../http/request.js'

export interface ProjectRouteOptions extends Pick<WebUiOptions,
  'listProjects' | 'createProject' | 'listProjectFileCounts' | 'getProject'
> {
  /** Host callback: performs owner-scoped project update and post-commit effects. */
  updateProject?: (
    ownerId: string,
    projectId: number,
    input: unknown,
    metadata: WriteRequestMetadata,
  ) => Promise<unknown>
  /** Host callback: soft-deletes a project and its owned resources. */
  deleteProject?: (ownerId: string, projectId: number, metadata: WriteRequestMetadata) => Promise<void>
  /** Host callback: restores an unexpired project trash record and its owned resources. */
  restoreProject?: (ownerId: string, projectId: number, metadata: WriteRequestMetadata) => Promise<unknown>
}

function parseIntegerPath(rawId: string): number | null {
  if (!/^[+-]?\d+$/.test(rawId)) return null
  const projectId = Number(rawId)
  return Number.isSafeInteger(projectId) ? projectId : null
}

export function registerProjectRoutes(
  app: FastifyInstance,
  userFromRequest: UserFromRequest,
  options: ProjectRouteOptions,
): void {
  if (options.listProjects) {
    app.get('/api/v1/projects', async (request, reply) => {
      const user = userFromRequest(request)
      const query = request.query as Record<string, unknown>
      const archived = queryBoolean(query, 'archived')
      const deleted = queryBoolean(query, 'deleted')
      if (archived === undefined || deleted === undefined)
        return reply.code(422).send({ detail: '查询参数必须是 true 或 false' })
      if (archived && deleted)
        return reply.code(400).send({ detail: 'archived 和 deleted 不能同时为 true' })
      return options.listProjects!(user.id, archived, deleted)
    })
  }

  if (options.createProject) {
    app.post('/api/v1/projects', async (request, reply) => {
      const user = userFromRequest(request)
      return reply.code(201).send(await options.createProject!(
        user.requestContext,
        request.body,
        writeRequestMetadata(request),
      ))
    })
  }

  if (options.listProjectFileCounts) {
    app.get('/api/v1/projects/file-counts', async (request) =>
      options.listProjectFileCounts!(userFromRequest(request).id),
    )
  }

  if (options.getProject) {
    app.get('/api/v1/projects/:projectId', async (request, reply) => {
      const user = userFromRequest(request)
      const rawId = (request.params as { projectId: string }).projectId
      const projectId = parseIntegerPath(rawId)
      if (projectId === null)
        return reply.code(422).send({ detail: '项目标识无效' })
      const project = await options.getProject!(user.requestContext.data.ownerId, projectId)
      if (project === null) return reply.code(404).send({ detail: '项目不存在' })
      return project
    })
  }

  if (options.updateProject) {
    app.patch('/api/v1/projects/:projectId', async (request, reply) => {
      const user = userFromRequest(request)
      const rawId = (request.params as { projectId: string }).projectId
      const projectId = parseIntegerPath(rawId)
      if (projectId === null)
        return reply.code(422).send({ detail: '项目标识无效' })
      return options.updateProject!(user.requestContext.data.ownerId, projectId, request.body, writeRequestMetadata(request))
    })
  }

  if (options.deleteProject) {
    app.delete('/api/v1/projects/:projectId', async (request, reply) => {
      const user = userFromRequest(request)
      const rawId = (request.params as { projectId: string }).projectId
      const projectId = parseIntegerPath(rawId)
      if (projectId === null)
        return reply.code(422).send({ detail: '项目标识无效' })
      await options.deleteProject!(user.requestContext.data.ownerId, projectId, writeRequestMetadata(request))
      return reply.code(204).send()
    })
  }

  if (options.restoreProject) {
    app.post('/api/v1/projects/:projectId/restore', async (request, reply) => {
      const user = userFromRequest(request)
      const rawId = (request.params as { projectId: string }).projectId
      const projectId = parseIntegerPath(rawId)
      if (projectId === null)
        return reply.code(422).send({ detail: '项目标识无效' })
      return options.restoreProject!(user.requestContext.data.ownerId, projectId, writeRequestMetadata(request))
    })
  }
}
