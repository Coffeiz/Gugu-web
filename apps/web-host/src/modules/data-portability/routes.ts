import {
  registerDataExportCreateRoute,
  registerDataExportPreviewRoute,
  registerDataExportCancelRoute,
  registerDataExportDeleteRoute,
  type DataExportDeleteOptions,
} from './exports.js'
import {
  registerDataImportResumeRoute,
  registerDataImportApplyRoute,
  registerDataImportRollbackRoute,
  registerDataImportRecoverRoute,
  registerDataImportCancelRoute,
  type DataImportCancelOptions,
  registerDataImportDeleteRoute,
  type DataImportDeleteOptions,
  registerDataImportPreflightRoute,
} from './imports.js'
import { registerPortabilityJobReadRoutes } from './jobs.js'
import type { FastifyInstance } from 'fastify'
import type { UserAuthOptions } from '../auth/contracts.js'
import type { WebUiOptions } from '../../http/options.js'
import { registerProtectedDomain } from '../../http/user.js'

export function registerPortabilityRoutes(app: FastifyInstance, auth: UserAuthOptions, options: WebUiOptions) {
  if (options.recoverDataImport) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerDataImportRecoverRoute(routes, userFromRequest, options.recoverDataImport!))
  }
  if (options.rollbackDataImport) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerDataImportRollbackRoute(routes, userFromRequest, options.rollbackDataImport!))
  }
  if (options.applyDataImport) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerDataImportApplyRoute(routes, userFromRequest, options.applyDataImport!))
  }
  if (options.resumeDataImport) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerDataImportResumeRoute(routes, userFromRequest, options.resumeDataImport!))
  }
  if (options.dataExportPreview) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerDataExportPreviewRoute(routes, {
      ...options.dataExportPreview!, requireUser: async (request) => { void userFromRequest(request) },
      ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
    }))
  }
  if (options.createDataExport) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerDataExportCreateRoute(routes, userFromRequest, options.createDataExport!))
  }
  if (options.cancelDataExport) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerDataExportCancelRoute(routes, userFromRequest, options.cancelDataExport!))
  }
  if (options.deleteDataExport) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerDataExportDeleteRoute(routes, {
      remove: options.deleteDataExport!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId,
    } satisfies DataExportDeleteOptions))
  }
  if (options.deleteDataImport) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerDataImportDeleteRoute(routes, {
      remove: options.deleteDataImport!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId,
    } satisfies DataImportDeleteOptions))
  }
  if (options.cancelDataImport && options.cleanupDataImportStaging && options.portabilityJobs) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerDataImportCancelRoute(routes, {
      cancel: options.cancelDataImport!,
      cleanup: options.cleanupDataImportStaging!,
      read: options.portabilityJobs!.getImport,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId,
    } satisfies DataImportCancelOptions))
  }
  if (options.preflightDataImport && options.portabilityJobs) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerDataImportPreflightRoute(routes, {
      preflight: options.preflightDataImport!,
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId,
    }))
  }
  if (options.portabilityJobs) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerPortabilityJobReadRoutes(routes, userFromRequest, options.portabilityJobs!))
  }
}
