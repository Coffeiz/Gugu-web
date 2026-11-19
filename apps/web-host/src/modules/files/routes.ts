import { type FastifyInstance } from 'fastify'
import { requestContext } from '@gugu/core'
import type { UserAuthOptions } from '../auth/contracts.js'
import { registerFileBrowserRoutes, registerFileReadRoutes, registerFolderReadRoutes } from './browse.js'
import { registerFolderWriteRoutes } from './folders/write.js'
import { registerFolderCopyRoute } from './folders/copy.js'
import { registerFolderDeleteRoute } from './folders/delete.js'
import { registerXlsxPreviewRoutes, registerFileThumbnailRoute, registerFileContentRoutes } from './content.js'
import { registerFileDeleteRoutes, registerFileRestoreRoutes, registerTrashRoutes } from './trash/service.js'
import { registerFileUpdateRoutes, registerFileCopyRoutes } from './store.js'
import { registerFileConflictRoutes, registerFileUploadRoutes } from './upload.js'
import { registerFileBatchDownloadRoutes, registerFolderDownloadRoutes } from './download.js'
import { registerFileArchiveRoutes } from './archive/service.js'
import { registerGlobalSearchRoute } from '../search/search.js'
import type { WebUiOptions } from '../../http/options.js'
import { registerProtectedDomain } from '../../http/user.js'

export function registerFileRoutes(app: FastifyInstance, auth: UserAuthOptions, options: WebUiOptions) {
  if (options.fileBrowser) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerFileBrowserRoutes(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        operations: options.fileBrowser!,
      })
    })
  }
  if (options.folderWrites) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerFolderWriteRoutes(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        operations: options.folderWrites!,
      })
    })
  }
  if (options.folderCopy) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerFolderCopyRoute(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        operations: options.folderCopy!,
      })
    })
  }
  if (options.folderDelete) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerFolderDeleteRoute(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        operations: options.folderDelete!,
      })
    })
  }
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
            preview: (ownerId, fileId) => options.fileReads!.xlsxPreview!(ownerId, fileId),
            image: (ownerId, fileId, imageId) => options.fileReads!.xlsxPreviewImage!(ownerId, fileId, imageId),
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
  if (options.folderReads) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerFolderReadRoutes(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        operations: options.folderReads!,
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
  if (options.trash) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerTrashRoutes(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        operations: options.trash!,
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
  if (options.fileConflicts) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerFileConflictRoutes(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        operations: options.fileConflicts!,
      })
    })
  }
  if (options.fileBatchDownloads) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerFileBatchDownloadRoutes(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        operations: options.fileBatchDownloads!,
      })
    })
  }
  if (options.fileArchives) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerFileArchiveRoutes(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        operations: options.fileArchives!,
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
  if (options.folderDownloads) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerFolderDownloadRoutes(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        operations: options.folderDownloads!,
      })
    })
  }
}
