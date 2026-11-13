import type { FastifyInstance } from 'fastify'
import { CoreError } from '@gugu/core'
import type { UserFromRequest, WebUiOptions } from '../../../app.js'
import type { WorkspaceBindingOperations } from '../persistence/workspace-bindings.js'

export type WorkspaceUpdateRouteHandler = (
  ownerId: string,
  workspaceId: number,
  input: unknown,
) => Promise<unknown>

export type WorkspaceListRouteHandler = (ownerId: string) => Promise<unknown>
export type WorkspaceDeleteRouteHandler = (ownerId: string, workspaceId: number) => Promise<unknown>

function pathId(value: string, name: string): number {
  if (!/^[+-]?\d+$/.test(value)) throw new CoreError('invalid_request', `${name} 无效`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new CoreError('invalid_request', `${name} 无效`)
  return parsed
}

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  userFromRequest: UserFromRequest,
  createWorkspace?: NonNullable<WebUiOptions['createWorkspace']>,
  bindings?: WorkspaceBindingOperations,
  updateWorkspace?: WorkspaceUpdateRouteHandler,
  listWorkspaces?: WorkspaceListRouteHandler,
  deleteWorkspace?: WorkspaceDeleteRouteHandler,
): void {
  if (listWorkspaces) {
    app.get('/api/v1/workspaces', async (request) =>
      listWorkspaces(userFromRequest(request).requestContext.data.ownerId),
    )
  }
  if (createWorkspace) {
    app.post('/api/v1/workspaces', async (request) =>
      createWorkspace(userFromRequest(request).requestContext.data.ownerId, request.body),
    )
  }
  if (updateWorkspace) {
    app.patch('/api/v1/workspaces/:workspace_id', async (request) => {
      const params = request.params as { workspace_id: string }
      const ownerId = userFromRequest(request).requestContext.data.ownerId
      return updateWorkspace(ownerId, pathId(params.workspace_id, '工作区 ID'), request.body)
    })
  }
  if (deleteWorkspace) {
    app.delete('/api/v1/workspaces/:workspace_id', async (request) => {
      const params = request.params as { workspace_id: string }
      const ownerId = userFromRequest(request).requestContext.data.ownerId
      return deleteWorkspace(ownerId, pathId(params.workspace_id, '工作区 ID'))
    })
  }
  if (!bindings) return

  app.post('/api/v1/workspaces/:workspace_id/bind/:session_id', async (request) => {
    const params = request.params as { workspace_id: string; session_id: string }
    const ownerId = userFromRequest(request).requestContext.data.ownerId
    return bindings.bind(
      ownerId,
      pathId(params.workspace_id, '工作区 ID'),
      pathId(params.session_id, '会话 ID'),
    )
  })

  app.delete('/api/v1/workspaces/binding/:session_id', async (request) => {
    const params = request.params as { session_id: string }
    const ownerId = userFromRequest(request).requestContext.data.ownerId
    const sessionId = pathId(params.session_id, '会话 ID')
    await bindings.unbind(ownerId, sessionId)
    return { ok: true, sessionId, workspaceId: null }
  })

  app.get('/api/v1/workspaces/session/:session_id', async (request) => {
    const params = request.params as { session_id: string }
    const ownerId = userFromRequest(request).requestContext.data.ownerId
    const sessionId = pathId(params.session_id, '会话 ID')
    return { sessionId, workspace: await bindings.current(ownerId, sessionId) }
  })
}
