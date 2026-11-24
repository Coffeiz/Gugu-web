import { type FastifyInstance } from 'fastify'
import { requestContext } from '@gugu/core'
import type { UserAuthOptions } from '../auth/contracts.js'
import { registerFileReadRoutes } from './browse.js'
import { registerXlsxPreviewRoutes, registerFileThumbnailRoute, registerFileContentRoutes } from './content.js'
import { registerFileDeleteRoutes, registerFileRestoreRoutes } from './trash/service.js'
import { registerFileUpdateRoutes, registerFileCopyRoutes } from './store.js'
import { registerFileUploadRoutes } from './upload.js'
import { registerGlobalSearchRoute } from '../search/search.js'
import type { WebUiOptions } from '../../http/options.js'
import { registerProtectedDomain } from '../../http/user.js'

export function registerFileRoutes(app: FastifyInstance, auth: UserAuthOptions, options: WebUiOptions) {
  if (options.fileReads) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerFileReadRoutes(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        operations: options.fileReads!,
      })
      if (options.fileReads?.xlsxPreview && options.fileReads.xlsxPreviewImage) {
        registerXlsxPreviewRoutes(routes, {
          requireUser: async (request) => { void userFromRequest(request) },
          ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
          operations: {
            preview: (ownerId, filePath) => options.fileReads!.xlsxPreview!(ownerId, filePath),
            image: (ownerId, filePath, imageId) => options.fileReads!.xlsxPreviewImage!(ownerId, filePath, imageId),
          },
        })
      }
      registerFileThumbnailRoute(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        operations: options.fileReads!,
      })
    })
  }
  if (options.fileUploads) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerFileUploadRoutes(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        operations: options.fileUploads!,
      })
    })
  }
  if (options.fileDeletes) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerFileDeleteRoutes(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        operations: options.fileDeletes!,
      })
    })
  }
  if (options.fileRestores) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerFileRestoreRoutes(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        operations: options.fileRestores!,
      })
    })
  }
  if (options.fileContents) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerFileContentRoutes(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        operations: options.fileContents!,
      })
    })
  }
  if (options.fileUpdates) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerFileUpdateRoutes(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        operations: options.fileUpdates!,
      })
    })
  }
  if (options.fileCopies) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerFileCopyRoutes(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        operations: options.fileCopies!,
      })
    })
  }
  if (options.globalSearch) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerGlobalSearchRoute(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        operations: options.globalSearch!,
      })
    })
  }
}
