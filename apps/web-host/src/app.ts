import { registerDataExportBrowserDownloadRoute } from './modules/data-portability/download.js'
import { registerTerminalWebsocket } from './modules/terminals/pty/websocket.js'
import Fastify from 'fastify'
import { DEFAULT_PUBLIC_SITE_CONFIG } from './modules/site/config.js'
import { registerStaticFrontend } from './static.js'
import { registerSiteConfigRoute } from './modules/site/routes.js'
import { installHttpErrorHandler } from './http/errors.js'
import { installFileUploadSupport } from './modules/files/upload.js'
import type { WebUiOptions } from './http/options.js'
import { registerUserRoutes } from './http/routes.js'
import { registerAdminRoutes } from './modules/admin/routes.js'

export type { AuthenticatedWebUser, UserFromRequest, WriteRequestMetadata, ClientResponse, ClientCreateInput, ClientOptions, EventOptions, NotificationOptions, TrackOptions, FeedbackOptions, WebUiOptions, UserAuthOptions } from './http/options.js'

export function createApp(options: WebUiOptions) {
  const app = Fastify({ logger: false, routerOptions: { ignoreTrailingSlash: true } })
  const jsonParser = app.getDefaultJsonParser('error', 'error')
  app.removeContentTypeParser('application/json')
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const source = typeof body === 'string' ? body : body.toString('utf8')
    if (source.length === 0) {
      done(null, undefined)
      return
    }
    jsonParser(request, source, done)
  })
  installHttpErrorHandler(app)
  if (options.fileUploads || options.workspaceDirectories?.files || options.userAvatar || options.preferences?.textFiles || options.attachmentUpload)
    installFileUploadSupport(app)
  app.get('/health', async () => ({ status: 'ok', app: options.appName }))
  app.get('/health/ready', async (_request, reply) => {
    try {
      if (await options.isReady()) return { status: 'ok' }
    } catch {
      options.onReadinessError?.()
    }
    return reply.code(503).send({ status: 'not_ready' })
  })
  registerSiteConfigRoute(app, options.publicSiteConfig ?? DEFAULT_PUBLIC_SITE_CONFIG)
  registerUserRoutes(app, options)
  if (options.terminalWebsocket && options.userAuth) {
    const closeTerminalWebsocket = registerTerminalWebsocket(app.server, { ...options.terminalWebsocket, auth: options.userAuth })
    app.addHook('onClose', closeTerminalWebsocket)
  }
  if (options.dataExportDownload) registerDataExportBrowserDownloadRoute(app, options.dataExportDownload)
  registerAdminRoutes(app, options)
  if (options.staticRoot) registerStaticFrontend(app, options.staticRoot)
  return app
}
