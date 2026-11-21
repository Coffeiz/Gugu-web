import { createDesktopImInbox } from '../src/main/im/gateway/inbound/inbox.ts'
import { createDesktopImDispatch } from '../src/main/im/gateway/delivery/dispatch.ts'
import { createDesktopImCallback } from '../src/main/im/gateway/interactions/callback.ts'
import { createDesktopQqPairing } from '../src/main/im/connect/platforms/qq/index.ts'
import { createDesktopQqGateway } from '../src/main/im/gateway/platforms/qq/index.ts'
import { createDesktopFeishuPairing } from '../src/main/im/connect/platforms/feishu/index.ts'
import { createDesktopFeishuGateway } from '../src/main/im/gateway/platforms/feishu/index.ts'
import { createDesktopWechatPairing } from '../src/main/im/connect/platforms/wechat/index.ts'
import { createDesktopWechatCursor, createDesktopWechatGateway } from '../src/main/im/gateway/platforms/wechat/index.ts'
import { agentModelPreviewPath } from '../src/shared/agent-model-preview.ts'
import { streamPreviewRunChanges } from '../src/main/agent/preview-run-changes.ts'
import { agentSessionPreviewPath } from '../src/shared/agent-session-preview.ts'
import { createDesktopRecordingTranscriber } from '../src/main/agent/voice-recording.ts'
import { createDesktopRuntimeLog } from '../src/main/log/index.ts'
import { desktopLogHandlers } from '../src/main/log/read.ts'
import { request } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createNodeProviderTransport, desktopTransportOptions, proxyFor, proxyOptionsFromEnvironment } from '@gugu/core/providers/node'
import { desktopFiles } from '../src/main/files/ipc.ts'
import { encodeAgentChatSse } from '@gugu/core/agent/chat-sse'
import { servePreviewFile } from '../src/main/files/preview.ts'
import { resourceHandlers } from '../src/main/mcp/ipc.ts'
import { scheduleHandlers } from '../src/main/schedules/ipc.ts'
import { mkdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DESKTOP_CHANNELS, MAX_FRAME } from '@gugu/core/desktop'
import { CoreHost, DesktopError, desktopReply, verifyArtifact } from '../src/main/core-host.ts'
import { desktopAgentAttachmentHandlers, removeDesktopAgentAttachmentFiles } from '../src/main/agent/attachments.ts'
import { handlePreviewAttachment, previewAttachmentPath } from '../src/main/agent/preview-attachments.ts'
import { auxiliaryModelHandlers, createDesktopEmbeddingResolver } from '../src/main/agent/auxiliary-model.ts'
import { agentModelHandlers, agentSessionHandlers } from '../src/main/agent/ipc.ts'
import { createDesktopAgentModelService, createDesktopAgentModelStore } from '../src/main/agent/model.ts'
import { createDesktopTelegramGateway } from '../src/main/im/gateway/platforms/telegram/index.ts'
import { pairingHandlers, telegramHandlers } from '../src/main/im/ipc.ts'
import { workspaceHandlers } from '../src/main/workspace/ipc.ts'
import { DesktopLifecycle } from '../src/main/lifecycle.ts'
import { desktopPreviewDataDirectory, createDesktopPreviewEncryption } from '../src/main/preview-directory.ts'
import { desktopPreviewRoutes, workspacePreviewRoutes } from '../../ui/src/desktop/bridge/preview-core.ts'

const previewMethods = new Map(desktopPreviewRoutes.map(({ endpoint, methods }) => [endpoint, new Set(methods)]))
previewMethods.set(agentSessionPreviewPath, new Set(['agentSessions']))
previewMethods.set(agentModelPreviewPath, new Set(['agentModel', 'auxiliaryModel']))
const workspacePreviewEndpoints = new Set(workspacePreviewRoutes.map(({ endpoint }) => endpoint))
const loopbackHosts = new Set(['127.0.0.1', 'localhost'])

async function readCall(req, methods) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > (req.url === '/__desktop-preview/preferences' ? MAX_FRAME : MAX_FRAME / 2)) throw new DesktopError('invalid_request', '预览请求过大')
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
  const artifactRoot = join(desktopRoot, 'resources', 'core-sidecar')
  let lifecycle
  const gateways = []
  return {
    name: 'gugu-desktop-core-preview',
    apply: 'serve',
    configureServer(server) {
      if (!server.httpServer || !loopbackHosts.has(server.config.server.host)) return
      // 每个检出目录和 Vite 端口各自使用独立预览库，避免并行 Electron/Vite 进程争用 SQLite。
      const directory = desktopPreviewDataDirectory(desktopRoot, homedir(), server.config.server.port ?? 5176)
      const report = createDesktopRuntimeLog(directory)
      const filesRoot = join(directory, 'Gugu-data')
      lifecycle = new DesktopLifecycle(async () => {
        const artifact = await verifyArtifact(artifactRoot).catch(() => {
          throw new DesktopError('artifact_invalid', '桌面预览需要 Core 制品，请先运行桌面 dev:prepare')
        })
        await mkdir(directory, { recursive: true, mode: 0o700 })
        const host = await CoreHost.launch(artifact.node, artifact.entry, join(directory, 'core.db'),
          artifact.manifest, undefined, filesRoot, artifact.workerEntry, artifact.agentRuntimeModule)
        host.setHostRequestHandler(async ({ method, params, signal }) => {
          if (method === 'agent.memory.resolveReflectionModel' && Object.keys(params).length === 2)
            return model.resolveReflectionModel(params.modelIdentity, params.modelId)
          if (method === 'agent.search.deep_research.available' || method === 'agent.search.similar_image_search.available') return false
          if (method === 'agent.files.globalSearch') return files.globalFileSearch(params.queries, params.mode, params.perType, signal)
          if (method === 'agent.files.resolveDroppedReference' || method === 'agent.files.resolveWorkspaceReference') return null
          if (method === 'network.resolveProxy') return previewProxy(new URL(params.origin)) ?? null
          throw new DesktopError('unsupported', '浏览器预览未配置此宿主能力')
        })
        return host
      })
      let activeManifest
      let starting
      function startCore() {
        if (starting) return starting
        starting = (async () => {
          const info = await stat(join(artifactRoot, 'manifest.json')).catch(() => {
            throw new DesktopError('artifact_invalid', '桌面预览需要 Core 制品，请先运行桌面 dev:prepare')
          })
          const manifest = `${info.ino}:${info.mtimeMs}:${info.size}`
          // 制品替换后复用 Vite 中的模型配置，只重启使用旧模块的 Core。
          if (activeManifest && activeManifest !== manifest) {
            await lifecycle.pause()
            report('host.stopped')
          }
          await lifecycle.start()
          if (activeManifest !== manifest) {
            activeManifest = manifest
            report('host.started')
            void lifecycle.request('agent.memory.resumeReflections').catch(() => {})
          }
        })().catch(error => {
          report('host.start_failed', { error })
          throw error
        }).finally(() => { starting = undefined })
        return starting
      }
      const files = desktopFiles(filesRoot, undefined, undefined, undefined,
        async id => {
          await startCore()
          return lifecycle.request('projects.board.get', { id })
        })
      const credentialDirectory = join(directory, 'credentials')
      const encryption = createDesktopPreviewEncryption(credentialDirectory)
      // Vite 预览没有 Electron 系统代理解析器，使用开发进程的代理设置。
      const previewProxy = url => proxyFor(url, proxyOptionsFromEnvironment(process.env))
      const resolveModelProxy = async url => {
        await startCore()
        const settings = await lifecycle.request('preferences.desktop.get')
        return settings.useSystemProxy ? previewProxy(url) : undefined
      }
      const model = createDesktopAgentModelService(createDesktopAgentModelStore(credentialDirectory, encryption), resolveModelProxy)
      const host = { async request(method, params) {
        await startCore()
        return lifecycle.request(method, params)
      } }
      const admit = createDesktopImInbox(host, encryption)
      const dispatch = createDesktopImDispatch(host, encryption, model, () => host.request('preferences.desktop.get'), (code, error) => report('gateway.degraded', { code, error }))
      const callback = createDesktopImCallback(host, model)
      const telegram = createDesktopTelegramGateway(credentialDirectory, encryption, undefined, resolveModelProxy, admit, dispatch, callback)
      const newTransport = () => createNodeProviderTransport(desktopTransportOptions(false, resolveModelProxy))
      const refresh = async gateway => { gateway.refresh(); await gateway.settled() }
      const wechatPairing = createDesktopWechatPairing(credentialDirectory, encryption, randomUUID(), newTransport(), () => refresh(wechat))
      const wechat = createDesktopWechatGateway(wechatPairing, admit, dispatch, newTransport, createDesktopWechatCursor(credentialDirectory, encryption), (code, error) => report('gateway.degraded', { code, error }))
      const feishuPairing = createDesktopFeishuPairing(credentialDirectory, encryption, randomUUID(), newTransport(), () => refresh(feishu))
      const feishu = createDesktopFeishuGateway(feishuPairing, admit, dispatch, newTransport, undefined, callback)
      const qqPairing = createDesktopQqPairing(credentialDirectory, encryption, randomUUID(), newTransport(), () => qq.refresh())
      const qq = createDesktopQqGateway(qqPairing, admit, dispatch, newTransport, undefined, callback,
        (code, error) => report('gateway.degraded', { code, error }), { host, encryption })
      gateways.push(telegram, wechat, feishu, qq)
      let startingIm
      const handlers = {
        ...desktopLogHandlers(directory),
        ...files.handlers,
        ...workspaceHandlers(lifecycle, async () => null, files.globalFileSearch, async id => {
          const file = await files.resolveWorkspaceReference(id)
          return file?.relativePath.split('/').at(-1) ?? null
        }),
        ...agentSessionHandlers(lifecycle, model, undefined, createDesktopEmbeddingResolver(credentialDirectory, encryption),
          ids => removeDesktopAgentAttachmentFiles(directory, ids)),
        ...desktopAgentAttachmentHandlers(lifecycle, directory,
          createDesktopRecordingTranscriber(credentialDirectory, encryption, resolveModelProxy)),
        ...auxiliaryModelHandlers(credentialDirectory, encryption, resolveModelProxy,
          () => lifecycle.request('agent.memory.invalidateEmbedding')),
        ...agentModelHandlers(model),
        ...telegramHandlers(telegram),
        ...pairingHandlers('wechat', wechatPairing, wechat.health),
        ...pairingHandlers('feishu', feishuPairing, feishu.health),
        ...pairingHandlers('qq', qqPairing, qq.health),
        ...resourceHandlers(lifecycle, resolveModelProxy),
        ...scheduleHandlers(lifecycle, async () => {
          throw new DesktopError('unsupported', '浏览器预览无法发送桌面系统通知')
        }),
      }
      server.middlewares.use((req, res, next) => {
        const methods = previewMethods.get(req.url)
        const content = req.url?.startsWith('/__local-files/content?')
        const upload = req.url?.startsWith('/__local-files/upload?')
        const attachment = req.url === previewAttachmentPath
        if (!methods && !content && !upload && !attachment) return next()
        const port = req.socket.localPort
        const trusted = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
          && [...loopbackHosts].some(host => req.headers.host === `${host}:${port}`)
          && req.headers.origin === `http://${req.headers.host}`
        const permittedFile = content
          ? ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
            && [...loopbackHosts].some(host => req.headers.host === `${host}:${port}`)
            && req.headers['sec-fetch-site'] === 'same-origin' && req.method === 'GET'
          : upload && trusted && req.method === 'POST' && req.headers['content-type'] === 'application/octet-stream'
        if ((content || upload) && !permittedFile) { res.writeHead(403).end(); return }
        const trustedCall = trusted && req.method === 'POST'
          && (req.headers['content-type'] === 'application/json'
            || (attachment && req.headers['content-type'] === 'application/octet-stream'))
        if (!trustedCall) res.statusCode = 403
        const socketPath = process.env.GUGU_DESKTOP_PREVIEW_SOCKET
        const secret = process.env.GUGU_DESKTOP_PREVIEW_SECRET
        if ((trustedCall || permittedFile) && socketPath && secret &&
          (content || upload || workspacePreviewEndpoints.has(req.url) || req.url === '/__desktop-preview/files' || req.url === '/__desktop-preview/im' || req.url === '/__desktop-preview/logs' || req.url === '/__desktop-preview/preferences' || req.url === agentModelPreviewPath || req.url === agentSessionPreviewPath || attachment)) {
          const upstream = request({
            socketPath, path: req.url, method: req.method,
            headers: { ...(req.headers['content-type'] ? { 'Content-Type': req.headers['content-type'] } : {}),
              ...(content && req.headers.range ? { Range: req.headers.range } : {}),
              ...(attachment && req.headers['content-type'] === 'application/octet-stream' ? {
                'x-gugu-attachment-name': req.headers['x-gugu-attachment-name'] ?? '',
                'x-gugu-attachment-type': req.headers['x-gugu-attachment-type'] ?? '',
                'x-gugu-attachment-voice': req.headers['x-gugu-attachment-voice'] ?? '0',
              } : {}), Accept: req.headers.accept ?? 'application/json', Authorization: secret },
          }, response => {
            res.writeHead(response.statusCode ?? 502, response.headers)
            response.pipe(res)
          })
          res.once('close', () => upstream.destroy())
          upstream.on('error', () => {
            if (res.headersSent) return res.destroy()
            if (content) { res.writeHead(503).end(); return }
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.setHeader('Cache-Control', 'no-store')
            res.end(JSON.stringify({ ok: false, error: { code: 'closed', message: '桌面应用正在启动或已退出' } }))
          })
          req.pipe(upstream)
          return
        }
        if (content || upload) {
          void servePreviewFile(req, res, files, content ? 'content' : 'upload')
          return
        }
        if (attachment) {
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.setHeader('Cache-Control', 'no-store')
          void desktopReply(trustedCall, async () => {
            await startCore()
            return handlePreviewAttachment(req, handlers)
          }).then(reply => res.end(JSON.stringify(reply)))
          return
        }
        const wantsChatStream = trustedCall && methods.has('agentSessions') && req.headers.accept === 'text/event-stream'
        res.setHeader('Content-Type', wantsChatStream ? 'text/event-stream' : 'application/json; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        if (wantsChatStream) res.setHeader('X-Accel-Buffering', 'no')
        const emit = event => {
          if (!res.destroyed) res.write(encodeAgentChatSse(event))
        }
        void desktopReply(trustedCall, async () => {
          const { method, args } = await readCall(req, methods)
          if (req.url === '/__desktop-preview/im') await (startingIm ??= Promise.all(gateways.map(gateway => gateway.start())))
          else if (method !== 'readLogs' && method !== 'files' && method !== 'agentModel' && method !== 'auxiliaryModel') await startCore()
          const handler = handlers[DESKTOP_CHANNELS[method]]
          const command = args[0]
          if (!wantsChatStream || method !== 'agentSessions') return handler(...args)
          if (command?.action === 'watchRuns') {
            await streamPreviewRunChanges(res, listener => lifecycle.onAgentRunChanged(listener))
            return null
          }
          if (command?.action === 'events') {
            const { events, ...page } = await handler(command)
            for (const event of events) emit(event)
            return page
          }
          if (command?.action !== 'send' && command?.action !== 'resume') return handler(...args)
          if (res.destroyed) return null
          res.flushHeaders()
          const connection = new AbortController()
          const detach = () => connection.abort()
          res.once('close', detach)
          try { return await handler(command, emit, connection.signal) } finally { res.off('close', detach) }
        }).then(reply => {
          if (wantsChatStream) {
            emit({ type: 'reply', reply })
            res.end()
          } else res.end(JSON.stringify(reply))
        })
      })
    },
    async closeBundle() {
      try { await Promise.all(gateways.map(gateway => gateway.stop())) } finally { await lifecycle?.close() }
    },
  }
}
