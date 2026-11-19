import { registerAgentSessionStateRoute } from './sessions/read.js'
import { registerAgentSessionDeleteRoute } from './sessions/delete.js'
import { type FastifyInstance, type FastifyRequest } from 'fastify'
import { requestContext } from '@gugu/core'
import type { UserAuthOptions } from '../auth/contracts.js'
import { registerAgentMessageLocationRoute } from './chat/history.js'
import { registerAgentMessageHistoryRoute } from './chat/history.js'
import { registerAgentInteractionSessionRoute } from './interactions/routes.js'
import { registerAgentInteractionRespondRoute } from './interactions/respond.js'
import { registerAgentSecretInteractionRoutes } from './interactions/secret.js'
import { registerAgentSessionRoute } from './sessions/read.js'
import { registerAgentChatRoutes } from './chat/routes.js'
import { registerAgentSessionRefreshRoute } from './sessions/update.js'
import { registerAgentImportedDraftQueueRoute, registerAgentPendingQueueReadRoute } from './chat/queue.js'
import { registerAgentPendingQueueReplaceRoute, registerAgentPendingQueuePatchRoute } from './chat/patch.js'
import { registerAgentPendingQueueClaimRoutes } from './chat/claims.js'
import { registerAgentSessionRenameRoute } from './sessions/update.js'
import { registerAgentToolEventDetailsRoute } from './chat/tools.js'
import { registerAgentMiscRoutes } from './misc.js'
import { registerAgentFilesystemAuthorizationRoutes } from './sandbox/routes.js'
import type { WebUiOptions } from '../../http/options.js'
import { registerProtectedDomain } from '../../http/user.js'

export function registerAgentRoutes(app: FastifyInstance, auth: UserAuthOptions, options: WebUiOptions) {
  if (options.agentChat || options.agentInteractionRespond || options.agentSecretInteraction || options.listAgentSessions || options.readAgentSessionState || options.lookupAgentInteractionSession || options.refreshAgentSession
    || options.agentPendingQueueReads || options.agentPendingQueuePatch || options.agentPendingQueueReplace || options.agentPendingQueueClaims
    || options.renameAgentSession || options.deleteAgentSession || options.listAgentMessages || options.locateAgentMessage
    || options.readAgentToolEventDetails || options.agentFilesystemAuthorization || options.agentMisc) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      {
        const requireUser = async (request: FastifyRequest) => { void userFromRequest(request) }
        const userIdFromRequest = (request: FastifyRequest) => userFromRequest(request).requestContext.data.ownerId
        if (options.agentChat) registerAgentChatRoutes(routes, { requireUser, userIdFromRequest, service: options.agentChat })
        if (options.agentInteractionRespond) registerAgentInteractionRespondRoute(routes, { requireUser, userIdFromRequest, service: options.agentInteractionRespond })
        if (options.agentSecretInteraction) registerAgentSecretInteractionRoutes(routes, { requireUser, userIdFromRequest, service: options.agentSecretInteraction })
        if (options.agentFilesystemAuthorization) {
          registerAgentFilesystemAuthorizationRoutes(routes, {
            requireUser,
            userIdFromRequest,
            ...options.agentFilesystemAuthorization,
          })
        }
        if (options.listAgentSessions) {
          registerAgentSessionRoute(routes, {
            requireUser,
            userIdFromRequest,
            list: options.listAgentSessions,
          })
        }
        if (options.readAgentSessionState) {
          registerAgentSessionStateRoute(routes, {
            requireUser,
            ownerIdFromRequest: userIdFromRequest,
            readState: options.readAgentSessionState,
          })
        }
        if (options.lookupAgentInteractionSession) {
          registerAgentInteractionSessionRoute(routes, {
            requireUser,
            userIdFromRequest,
            lookup: options.lookupAgentInteractionSession,
          })
        }
        if (options.refreshAgentSession) {
          registerAgentSessionRefreshRoute(routes, {
            requireUser,
            userIdFromRequest,
            refresh: options.refreshAgentSession,
          })
        }
        if (options.agentPendingQueueReads) {
          const queueOptions = {
            requireUser,
            userIdFromRequest,
            readQueue: options.agentPendingQueueReads.readQueue,
            readImportedDrafts: options.agentPendingQueueReads.readImportedDrafts,
            ...(options.agentPendingQueueReads.nowSeconds
              ? { nowSeconds: options.agentPendingQueueReads.nowSeconds }
              : {}),
          }
          registerAgentImportedDraftQueueRoute(routes, queueOptions)
          registerAgentPendingQueueReadRoute(routes, queueOptions)
        }
        if (options.agentPendingQueuePatch) {
          registerAgentPendingQueuePatchRoute(routes, {
            requireUser,
            userIdFromRequest,
            ...options.agentPendingQueuePatch,
          })
        }
        if (options.agentPendingQueueReplace) {
          registerAgentPendingQueueReplaceRoute(routes, {
            requireUser,
            userIdFromRequest,
            ...options.agentPendingQueueReplace,
          })
        }
        if (options.agentPendingQueueClaims) {
          registerAgentPendingQueueClaimRoutes(routes, {
            requireUser,
            userIdFromRequest,
            ...options.agentPendingQueueClaims,
          })
        }
        if (options.renameAgentSession) {
          registerAgentSessionRenameRoute(routes, {
            requireUser,
            userIdFromRequest,
            rename: options.renameAgentSession,
          })
        }
        if (options.deleteAgentSession) {
          registerAgentSessionDeleteRoute(routes, {
            requireUser,
            userIdFromRequest,
            operations: options.deleteAgentSession,
          })
        }
        if (options.listAgentMessages) {
          registerAgentMessageHistoryRoute(routes, {
            requireUser,
            userIdFromRequest,
            list: options.listAgentMessages,
          })
        }
        if (options.locateAgentMessage) {
          registerAgentMessageLocationRoute(routes, {
            requireUser,
            userIdFromRequest,
            locate: options.locateAgentMessage,
          })
        }
        if (options.readAgentToolEventDetails) {
          registerAgentToolEventDetailsRoute(routes, {
            requireUser,
            userIdFromRequest,
            readDetails: options.readAgentToolEventDetails,
          })
        }
        if (options.agentMisc) {
          registerAgentMiscRoutes(routes, {
            requireUser,
            ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
            ...options.agentMisc,
          })
        }
      },
    )
  }
}
