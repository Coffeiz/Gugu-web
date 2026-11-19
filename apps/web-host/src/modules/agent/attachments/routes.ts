import { registerAttachmentDownloadRoute } from './download.js'
import { registerAgentAttachmentUploadRoute } from './upload.js'
import { registerAttachmentDraftDeleteRoute } from './delete.js'
import { registerAttachmentDraftClearRoute } from './clear.js'
import { registerAttachmentThumbnailRoute } from './thumbnail.js'
import { type FastifyInstance } from 'fastify'
import { requestContext } from '@gugu/core'
import type { UserAuthOptions } from '../../auth/contracts.js'
import type { WebUiOptions } from '../../../http/options.js'
import { registerProtectedDomain } from '../../../http/user.js'

export function registerAttachmentRoutes(app: FastifyInstance, auth: UserAuthOptions, options: WebUiOptions) {
  if (options.attachmentDownload) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerAttachmentDownloadRoute(routes, { ...options.attachmentDownload!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId }))
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerAttachmentThumbnailRoute(routes, { ...options.attachmentDownload!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId }))
  }
  if (options.attachmentUpload) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerAgentAttachmentUploadRoute(routes, {
      ...options.attachmentUpload!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId,
    }))
  }
  if (options.attachmentDelete) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerAttachmentDraftDeleteRoute(routes, {
      ...options.attachmentDelete!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId,
    }))
  }
  if (options.attachmentClear) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerAttachmentDraftClearRoute(routes, {
      ...options.attachmentClear!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId,
    }))
  }
}
