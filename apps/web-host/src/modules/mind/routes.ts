import type { FastifyInstance } from 'fastify'
import type { WebUiOptions } from '../../http/options.js'
import { registerProtectedDomain } from '../../http/user.js'
import type { UserAuthOptions } from '../auth/contracts.js'
import { registerMindNoteReadRoutes, registerMindNoteCreateRoute, registerMindNoteMutationRoutes } from './notes.js'
import { registerMindCanvasReadRoutes, registerMindCanvasMutationRoutes } from './canvas.js'
import { registerMindReferenceSuggestRoute } from './references.js'
import { registerMindCanvasNoteMutationRoutes, registerMindCanvasItemMutationRoutes, registerMindRefNodeCreateRoute } from './items.js'
import { registerMindCanvasRelationMutationRoutes } from './relations.js'

export function registerMindRoutes(app: FastifyInstance, auth: UserAuthOptions, options: WebUiOptions) {
  if (options.mindNotes)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerMindNoteReadRoutes(
        routes,
        (request) => userFromRequest(request).requestContext.data.ownerId,
        options.mindNotes!,
      ),
    )
  if (options.mindCanvasReads)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerMindCanvasReadRoutes(
        routes,
        (request) => userFromRequest(request).requestContext.data.ownerId,
        options.mindCanvasReads!,
      ),
    )
  if (options.mindRefSuggest)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerMindReferenceSuggestRoute(routes, {
        ownerId: (request) => userFromRequest(request).requestContext.data.ownerId,
        operations: options.mindRefSuggest!,
      }),
    )
  if (options.mindCanvasMutations)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerMindCanvasMutationRoutes(routes, userFromRequest, options.mindCanvasMutations!),
    )
  if (options.mindCanvasNoteMutations)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerMindCanvasNoteMutationRoutes(routes, userFromRequest, options.mindCanvasNoteMutations!),
    )
  if (options.mindCanvasItemMutations)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerMindCanvasItemMutationRoutes(routes, userFromRequest, options.mindCanvasItemMutations!),
    )
  if (options.mindCanvasRelationMutations)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerMindCanvasRelationMutationRoutes(routes, userFromRequest, options.mindCanvasRelationMutations!),
    )
  if (options.mindRefNodeCreate)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerMindRefNodeCreateRoute(routes, userFromRequest, options.mindRefNodeCreate!),
    )
  if (options.mindNoteCreate)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerMindNoteCreateRoute(routes, userFromRequest, options.mindNoteCreate!),
    )
  if (options.mindNoteMutations)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerMindNoteMutationRoutes(routes, userFromRequest, options.mindNoteMutations!),
    )
}
