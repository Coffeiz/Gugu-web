import { registerMcpStatusRoute } from './status.js'
import { registerMcpServerCreateRoute, registerMcpServerRoutes } from './servers.js'
import { registerMcpConnectionTestRoute } from './test-connection.js'
import { registerMcpServerListRoute } from './server-list.js'
import { registerMcpRuntimeRoutes } from './runtime-routes.js'
import { type FastifyInstance } from 'fastify'
import { requestContext } from '@gugu/core'
import type { UserAuthOptions } from '../auth/contracts.js'
import type { WebUiOptions } from '../../http/options.js'
import { registerProtectedDomain } from '../../http/user.js'

export function registerMcpRoutes(app: FastifyInstance, auth: UserAuthOptions, options: WebUiOptions) {
  if (options.mcpStatus) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerMcpStatusRoute(routes, { ...options.mcpStatus!, requireUser: async request => { void userFromRequest(request) } }))
  }
  if (options.mcpServerCreate) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerMcpServerCreateRoute(routes, {
      ...options.mcpServerCreate!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId,
    }))
  }
  if (options.mcpServerConfig) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerMcpServerRoutes(routes, {
      ...options.mcpServerConfig!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId,
    }))
  }
  if (options.mcpConnectionTest) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerMcpConnectionTestRoute(routes, {
      ...options.mcpConnectionTest!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId,
    }))
  }
  if (options.mcpServerList) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerMcpServerListRoute(routes, {
      ...options.mcpServerList!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId,
    }))
  }
  if (options.mcpRuntime) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerMcpRuntimeRoutes(routes, {
      ...options.mcpRuntime!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId,
    }))
    if (options.mcpRuntime.runtime.close) app.addHook('onClose', async () => options.mcpRuntime!.runtime.close!())
  }
}
