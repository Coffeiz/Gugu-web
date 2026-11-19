import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DESKTOP_CHANNELS, MAX_FRAME } from '@gugu/core/desktop'
import { CoreHost, DesktopError, desktopReply, verifyArtifact } from '../desktop/src/main/core-host.ts'
import { desktopHandlers } from '../desktop/src/main/ipc/index.ts'
import { DesktopLifecycle } from '../desktop/src/main/lifecycle.ts'
import { desktopPreviewRoutes } from './src/desktop/preview-core.ts'

const previewMethods = new Map(desktopPreviewRoutes.map(({ endpoint, methods }) => [endpoint, new Set(methods)]))
const loopbackHosts = new Set(['127.0.0.1', 'localhost'])

async function readCall(req, methods) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_FRAME / 2) throw new DesktopError('invalid_request', '预览请求过大')
    chunks.push(chunk)
  }
  let call
  try { call = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new DesktopError('invalid_request', '预览请求格式无效') }
  if (!methods.has(call?.method) || !Array.isArray(call.args)) {
    throw new DesktopError('invalid_request', '预览请求无效')
  }
  return call
}

export function desktopCorePreview(desktopRoot) {
  const checkout = createHash('sha256').update(desktopRoot).digest('hex').slice(0, 16)
  // 每个检出目录有独立预览库，位于用户目录，避开桌面应用数据和工作区同步。
  const directory = join(homedir(), '.gugu-desktop-preview', checkout)
  let lifecycle
  return {
    name: 'gugu-desktop-core-preview',
    apply: 'serve',
    configureServer(server) {
      if (!server.httpServer || !loopbackHosts.has(server.config.server.host)) return
      lifecycle = new DesktopLifecycle(async () => {
        const artifact = await verifyArtifact(join(desktopRoot, 'resources', 'core-sidecar')).catch(() => {
          throw new DesktopError('artifact_invalid', '桌面预览需要 Core 制品，请先运行桌面 dev:prepare')
        })
        await mkdir(directory, { recursive: true, mode: 0o700 })
        return CoreHost.launch(artifact.node, artifact.entry, join(directory, 'core.db'), artifact.manifest)
      })
      const handlers = desktopHandlers(lifecycle, async () => null)
      server.middlewares.use((req, res, next) => {
        const methods = previewMethods.get(req.url)
        if (!methods) return next()
        const port = req.socket.localPort
        const trusted = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
          && [...loopbackHosts].some(host => req.headers.host === `${host}:${port}`)
          && req.headers.origin === `http://${req.headers.host}`
          && req.method === 'POST'
          && req.headers['content-type'] === 'application/json'
        if (!trusted) res.statusCode = 403
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        void desktopReply(trusted, async () => {
          const { method, args } = await readCall(req, methods)
          await lifecycle.start()
          return handlers[DESKTOP_CHANNELS[method]](...args)
        }).then(reply => res.end(JSON.stringify(reply)))
      })
    },
    closeBundle() {
      return lifecycle?.close()
    },
  }
}
