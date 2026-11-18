import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DESKTOP_CHANNELS, MAX_FRAME } from '@gugu/core/desktop'
import { CoreHost, DesktopError, desktopHandlers, desktopReply, verifyArtifact } from '../desktop/src/main/core-host.ts'
import { DesktopLifecycle } from '../desktop/src/main/lifecycle.ts'
import { desktopPreviewCalendarEndpoint, desktopPreviewCalendarMethods } from './src/desktop/preview-calendar.ts'

const previewMethods = new Set(desktopPreviewCalendarMethods)
const loopbackHosts = new Set(['127.0.0.1', 'localhost'])

async function readCall(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_FRAME / 2) throw new DesktopError('invalid_request', '日历预览请求过大')
    chunks.push(chunk)
  }
  let call
  try { call = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new DesktopError('invalid_request', '日历预览请求格式无效') }
  if (!previewMethods.has(call?.method) || !Array.isArray(call.args)) {
    throw new DesktopError('invalid_request', '日历预览请求无效')
  }
  return call
}

export function desktopCalendarPreview(desktopRoot) {
  const checkout = createHash('sha256').update(desktopRoot).digest('hex').slice(0, 16)
  // 每个检出目录有独立预览库，位于用户目录，避开桌面应用数据和工作区同步。
  const directory = join(homedir(), '.gugu-desktop-preview', checkout)
  let lifecycle
  return {
    name: 'gugu-desktop-calendar-preview',
    apply: 'serve',
    configureServer(server) {
      if (!server.httpServer || !loopbackHosts.has(server.config.server.host)) return
      lifecycle = new DesktopLifecycle(async () => {
        const artifact = await verifyArtifact(join(desktopRoot, 'resources', 'core-sidecar')).catch(() => {
          throw new DesktopError('artifact_invalid', '日历预览需要桌面 Core 制品，请先运行桌面 dev:prepare')
        })
        await mkdir(directory, { recursive: true, mode: 0o700 })
        return CoreHost.launch(artifact.node, artifact.entry, join(directory, 'core.db'), artifact.manifest)
      })
      const handlers = desktopHandlers(lifecycle, async () => null)
      server.middlewares.use((req, res, next) => {
        if (req.url !== desktopPreviewCalendarEndpoint) return next()
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
          const { method, args } = await readCall(req)
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
