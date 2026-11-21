import { shouldOpenFileInSystem } from '../../../ui/src/shared/utils/filePreviewTypes.js'
import { createDesktopImAttachmentSender } from './im/gateway/delivery/attachments.js'
import { createDesktopImCallback } from './im/gateway/interactions/callback.js'
import { createDesktopQqReferences } from './im/gateway/platforms/qq/references.js'
import { createDesktopQqGateway } from './im/gateway/platforms/qq/index.js'
import { createDesktopFeishuGateway } from './im/gateway/platforms/feishu/index.js'
import { createDesktopRecordingTranscriber } from './agent/voice-recording.js'
import { createDesktopWechatCursor, createDesktopWechatGateway } from './im/gateway/platforms/wechat/index.js'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { createDesktopQqPairing } from './im/connect/platforms/qq/index.js'
import { createDesktopFeishuPairing } from './im/connect/platforms/feishu/index.js'
import { createDesktopWechatPairing } from './im/connect/platforms/wechat/index.js'
import { createNodeProviderTransport, desktopTransportOptions } from '@gugu/core/providers/node'
import { createDesktopImDispatch } from './im/gateway/delivery/dispatch.js'
import { startDesktopPreviewAgent } from './preview-agent.js'
import { createRemoteAuthClient } from '@gugu/core/auth/client'
import { createRemoteByokClient } from '@gugu/core/byok/client'
import { directDesktopFetch } from './network.js'
import { resolveDesktopSystemProxy } from './proxy.js'
import { createDesktopImInbox } from './im/gateway/inbound/inbox.js'
import { createDesktopImPendingAskStore } from './im/gateway/inbound/pending-asks.js'
import { createDesktopTelegramGateway } from './im/gateway/platforms/telegram/index.js'
import { telegramHandlers, pairingHandlers } from './im/ipc.js'
import { desktopTerminalHandlers } from './terminal/ipc.js'
import { encodeWorkspaceFileReferenceId } from './files/service.js'
import { desktopFiles } from './files/ipc.js'
import { auxiliaryModelHandlers, createDesktopEmbeddingResolver, createDesktopImVoiceTranscriber } from './agent/auxiliary-model.js'
import { agentModelHandlers, agentSessionHandlers } from './agent/ipc.js'
import { desktopAgentAttachmentHandlers, readDesktopAgentAttachment, removeDesktopAgentAttachmentFiles } from './agent/attachments.js'
import { createDesktopAgentModelService, createDesktopAgentModelStore } from './agent/model.js'
import { desktopAgentToolPolicy } from './agent/tool-policy.js'
import { resourceHandlers } from './mcp/ipc.js'
import { scheduleHandlers } from './schedules/ipc.js'
import { deliverLocalReminder, startLocalReminders } from './schedules/reminders.js'
import { DESKTOP_CHANNELS, type DesktopAppearancePreferences, type DesktopProjectDetails } from '@gugu/core/desktop'
import { registerPreviewWindows } from './preview-windows.js'
import { registerProjectWindows } from './project-windows.js'
import { createDroppedFileReferences } from './files/dropped-references.js'
import { desktopLogHandlers } from './log/read.js'
import { createDesktopRuntimeLog, desktopLogSinks } from './log/index.js'
import {
  app,
  BrowserWindow,
  ipcMain,
  powerMonitor,
  Menu,
  nativeImage,
  dialog,
  protocol,
  net,
  safeStorage,
  screen,
  session,
  shell,
} from 'electron'
import { autoUpdater } from 'electron-updater'
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import {
  CoreHost,
  verifyArtifact,
  desktopReply,
  DesktopError,
} from './core-host.js'
import { workspaceHandlers } from './workspace/ipc.js'
import { createDesktopMailService } from './mail/index.js'
import { createDesktopMailAttachmentResolver } from './mail/attachments.js'
import { registerDesktopIpc } from './ipc/register.js'
import { createRemoteSessionStore } from './auth/store.js'
import { createRemoteAgentDeepResearchClient, createRemoteAgentSearchAvailabilityClient, createRemoteAgentSimilarImageSearchClient, RemoteAgentSearchError } from '@gugu/core/agent/search-client'
import { desktopDeepResearchInput, desktopSimilarImageHostInput, MAX_DESKTOP_SEARCH_IMAGE_BYTES } from '@gugu/core/agent/search-contracts'
import { createRemoteAccountHandlers } from './auth/session.js'
import { DesktopLifecycle } from './lifecycle.js'
import {
  createMainWindowSizeStore,
  secureWindow,
  trustedCaller,
  windowOptions,
  uiResourcePath,
  DESKTOP_UI_URL,
} from './windows.js'
import { DesktopUpdater } from './updater.js'
import { sandboxDiagnostics } from '../sandbox/diagnostics.js'

app.setName('咕咕桌面验证')
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'gugu-desktop',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
])
const smoke = process.argv.includes('--smoke')
const devUiUrl = !app.isPackaged ? process.env.GUGU_DESKTOP_DEV_URL : undefined
const previewSocket = devUiUrl && process.env.GUGU_DESKTOP_PREVIEW_SOCKET
const previewSecret = devUiUrl && process.env.GUGU_DESKTOP_PREVIEW_SECRET
const devNode = previewSocket && previewSecret ? process.env.GUGU_DESKTOP_DEV_NODE : undefined
delete process.env.GUGU_DESKTOP_DEV_NODE
delete process.env.GUGU_DESKTOP_PREVIEW_SOCKET
delete process.env.GUGU_DESKTOP_PREVIEW_SECRET
let dataDirectory = join(app.getPath('appData'), 'com.gugu.desktop.preview')
if (smoke) {
  const provided = process.env.GUGU_DESKTOP_TEST_DIRECTORY
  if (!provided) throw new Error('冒烟必须显式提供临时目录')
  const target = realpathSync(provided),
    temporary = realpathSync(tmpdir())
  if (
    !target.startsWith(temporary + sep) ||
    readFileSync(join(target, '.gugu-smoke'), 'utf8') !== 'gugu-desktop-smoke-v1'
  )
    throw new Error('冒烟目录未经隔离验证')
  dataDirectory = target
}
mkdirSync(dataDirectory, { recursive: true })
app.setPath('userData', dataDirectory)
if (!app.requestSingleInstanceLock()) app.quit()
else {
  const report = createDesktopRuntimeLog(dataDirectory)
  let lifecycle: DesktopLifecycle | undefined,
    quitting = false
  let qq: ReturnType<typeof createDesktopQqGateway> | undefined
  let feishu: ReturnType<typeof createDesktopFeishuGateway> | undefined
  let wechat: ReturnType<typeof createDesktopWechatGateway> | undefined
  let telegram: ReturnType<typeof createDesktopTelegramGateway> | undefined
  let closing = false
  let stopReminders: (() => void) | undefined
  app.on('before-quit', (event) => {
    if (quitting || !lifecycle) return
    event.preventDefault()
    if (closing) return
    closing = true
    stopReminders?.()
    const stopIm = Promise.allSettled([telegram?.stop(), wechat?.stop(), feishu?.stop(), qq?.stop()]).then(results => {
      for (const result of results) if (result.status === 'rejected') report('host.stop_failed', { error: result.reason })
    })
    void stopIm.then(() => lifecycle?.close()).then(() => report('host.stopped'), error => report('host.stop_failed', { error })).finally(() => {
      quitting = true
      app.quit()
    })
  })
  app.on('window-all-closed', () => app.quit())
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0]
    if (window) {
      if (window.isMinimized()) window.restore()
      window.focus()
    }
  })
  void app
    .whenReady()
    .then(async () => {
      if (devUiUrl) {
        const devUrl = new URL(devUiUrl)
        if (
          devUrl.protocol !== 'http:' ||
          !['127.0.0.1', 'localhost'].includes(devUrl.hostname)
        )
          throw new DesktopError('invalid_request', '桌面开发界面必须来自本机 Vite 服务')
      }
      if (!smoke && !['win32', 'darwin'].includes(process.platform))
        throw new DesktopError(
          'unsupported',
          '桌面验证版仅面向 macOS 与 Windows；Linux 请使用多用户服务端',
        )
      const resource = app.isPackaged
        ? process.resourcesPath
        : join(app.getAppPath(), 'resources')
      const runtime = devNode
        ? {
          node: devNode,
          entry: resolve(app.getAppPath(), '../../packages/core/dist/runtime/transport/stdio.js'),
          workerEntry: resolve(app.getAppPath(), '../../packages/core/dist/runtime/worker.js'),
          agentRuntimeModule: resolve(app.getAppPath(), '.tools/agent/runtime.mjs'),
          manifest: undefined,
        }
        : await verifyArtifact(join(resource, 'core-sidecar'))
      mkdirSync(dataDirectory, { recursive: true })
      const filesRoot = join(smoke ? dataDirectory : app.getPath('documents'), 'Gugu-data')
      lifecycle = new DesktopLifecycle(() =>
        CoreHost.launch(
          runtime.node,
          runtime.entry,
          join(dataDirectory, 'core.db'),
          runtime.manifest,
          undefined, filesRoot, runtime.workerEntry, runtime.agentRuntimeModule,
        ),
      )
      await lifecycle.start()
      const host = lifecycle
      const systemProxy = session.fromPartition('gugu-system-proxy')
      await systemProxy.setProxy({ mode: 'system' })
      const resolveSystemProxy = (origin: unknown) =>
        resolveDesktopSystemProxy(origin, url => systemProxy.resolveProxy(url))
      const networkPreferences = await host.request<DesktopAppearancePreferences>('preferences.desktop.get')
      let useSystemProxy = networkPreferences.useSystemProxy === true
      let fileOpenPreference = networkPreferences.fileOpenPreference
      const resolveModelProxy = async (url: URL) => useSystemProxy ? resolveSystemProxy(url.origin) : undefined
      const remoteFetch: typeof fetch = (input, init) => useSystemProxy
        ? systemProxy.fetch(input instanceof URL ? input.href : input, init)
        : directDesktopFetch(input, init)
      const remoteSessionStore = createRemoteSessionStore(dataDirectory, safeStorage)
      const remoteSearchAvailable = createRemoteAgentSearchAvailabilityClient(remoteFetch)
      const remoteDeepResearch = createRemoteAgentDeepResearchClient(remoteFetch)
      const remoteSimilarImageSearch = createRemoteAgentSimilarImageSearchClient(remoteFetch)
      const agentModel = createDesktopAgentModelService(createDesktopAgentModelStore(dataDirectory, safeStorage), resolveModelProxy)
      const admitIm = createDesktopImInbox(host, safeStorage, dataDirectory)
      const pendingImAsks = createDesktopImPendingAskStore(dataDirectory, safeStorage)
      const imAttachments = createDesktopImAttachmentSender(dataDirectory, safeStorage)
      const dispatchIm = createDesktopImDispatch(host, safeStorage, agentModel, () => host.request<DesktopAppearancePreferences>('preferences.desktop.get'), (code, error) => report('gateway.degraded', { code, error }), imAttachments.register)
      const callbackIm = createDesktopImCallback(host, agentModel)
      let imTranscriber: Promise<ReturnType<typeof createDesktopImVoiceTranscriber>> | undefined
      const transcribeImVoice = async (input: { bytes: Uint8Array; mime: string; ext: string }, signal: AbortSignal,
        authorize: () => Promise<boolean>) => {
        imTranscriber ??= (async () => {
          const resolveMedia = createRequire(devNode ? join(app.getAppPath(), 'package.json') : resolve(runtime.entry, '../../../../package.json'))
          const url = pathToFileURL(resolveMedia.resolve('@gugu/gateway/media')).href
          const { createImAudioProcessor } = await import(url) as typeof import('@gugu/gateway/media')
          return createDesktopImVoiceTranscriber(dataDirectory, safeStorage, createImAudioProcessor({ nodePath: runtime.node }),
            resolveModelProxy, code => report('gateway.degraded', { code }))
        })().catch(error => { imTranscriber = undefined; throw error })
        return (await imTranscriber).transcribe(input, signal, authorize)
      }
      const imVoice = { transcribe: transcribeImVoice, report: (error: unknown) => report('gateway.degraded', { code: 'im_voice_failed', error }) }
      const gateway = telegram = createDesktopTelegramGateway(dataDirectory, safeStorage, undefined, resolveModelProxy, admitIm, dispatchIm, callbackIm, imVoice, host, pendingImAsks)
      const newImTransport = () => createNodeProviderTransport(desktopTransportOptions(false, resolveModelProxy))
      // 扫码任务只在本进程有效，使用本次启动的本地身份隔离。
      const wechatPairing = createDesktopWechatPairing(dataDirectory, safeStorage, randomUUID(), newImTransport(), async () => { wechat?.refresh(); await wechat?.settled() })
      const wechatGateway = wechat = createDesktopWechatGateway(wechatPairing, admitIm, dispatchIm, newImTransport, createDesktopWechatCursor(dataDirectory, safeStorage), (code, error) => report('gateway.degraded', { code, error }))
      const feishuPairing = createDesktopFeishuPairing(dataDirectory, safeStorage, randomUUID(), newImTransport(), async () => {
        feishu?.refresh()
        await feishu?.settled()
      })
      const feishuGateway = feishu = createDesktopFeishuGateway(feishuPairing, admitIm, dispatchIm, newImTransport, undefined, callbackIm, imVoice, { host, encryption: safeStorage }, pendingImAsks)
      const qqPairing = createDesktopQqPairing(dataDirectory, safeStorage, randomUUID(), newImTransport(), () => qq?.refresh())
      const qqGateway = qq = createDesktopQqGateway(qqPairing, admitIm, dispatchIm, newImTransport, undefined, callbackIm,
        (code, error) => report('gateway.degraded', { code, error }), { host, encryption: safeStorage, dataDirectory, voice: imVoice, references: createDesktopQqReferences(dataDirectory, safeStorage) })
      if (!smoke) await Promise.all([gateway.start(), wechatGateway.start(), feishuGateway.start(), qqGateway.start()])
      const uiPath = app.isPackaged
        ? join(app.getAppPath(), 'ui/desktop.html')
        : resolve(app.getAppPath(), '../ui/dist-desktop/desktop.html')
      const uiUrl = DESKTOP_UI_URL
      const trustedUiUrl = devUiUrl ?? uiUrl
      const readProject = (id: number) => host.request<DesktopProjectDetails>('projects.board.get', { id })
      const droppedReferences = createDroppedFileReferences(dataDirectory, path => shell.openPath(path))
      const files = desktopFiles(filesRoot, {
        async save(name) {
          const options = { defaultPath: name }
          const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options)
          return result.canceled ? undefined : result.filePath
        },
        reveal(path) { shell.showItemInFolder(path) },
        open: path => shell.openPath(path),
        async pickDirectory() {
          const options: Electron.OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] }
          const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
          return result.canceled ? undefined : result.filePaths[0]
        },
        trash: path => shell.trashItem(path),
        async thumbnail(bytes, name) {
          const systemThumbnail = process.platform === 'darwin' || process.platform === 'win32'
          if (!systemThumbnail || /\.(?:jpe?g|png)$/i.test(name)) {
            const image = nativeImage.createFromBuffer(bytes)
            if (!image.isEmpty()) {
              const { width, height } = image.getSize()
              if (width <= 384 && height <= 256) return image.toPNG()
              return image.resize(width / height >= 384 / 256 ? { width: 384 } : { height: 256 }).toPNG()
            }
            if (!systemThumbnail) return undefined
          }
          // 仅把已经通过工作区校验的文件内容交给系统缩略图服务。
          const directory = await mkdtemp(join(tmpdir(), 'gugu-thumbnail-'))
          try {
            const path = join(directory, 'image' + extname(name))
            await writeFile(path, bytes, { mode: 0o600 })
            const image = await nativeImage.createThumbnailFromPath(path, { width: 384, height: 256 })
            return image.isEmpty() ? undefined : image.toPNG()
          } finally {
            await rm(directory, { recursive: true, force: true })
          }
        },
      }, join(dataDirectory, 'file-workspaces.json'), dataDirectory, readProject)
      const desktopMail = createDesktopMailService(dataDirectory, safeStorage, undefined,
        createDesktopMailAttachmentResolver(async id => id.startsWith('drop-')
          ? droppedReferences.resolve(id) : files.resolveWorkspaceReference(id)))
      let previewWindows: ReturnType<typeof registerPreviewWindows> | undefined
      const agentAttachments = desktopAgentAttachmentHandlers(host, dataDirectory,
        createDesktopRecordingTranscriber(dataDirectory, safeStorage, resolveModelProxy))
      const resolveEmbedding = createDesktopEmbeddingResolver(dataDirectory, safeStorage)
      const agentLogSinks = desktopLogSinks(dataDirectory)
      host.setHostRequestHandler(async ({ method, params, signal }) => {
        if (method === 'agent.email.accounts' && Object.keys(params).length === 0)
          return desktopMail.listAccounts()
        if (method === 'agent.email.attachments')
          return desktopMail.inspectAgentAttachments(params, signal)
        if (method === 'agent.email.send') {
          signal.throwIfAborted()
          return desktopMail.sendForAgent(params, signal)
        }
        if (method === 'agent.tools.policy' && Object.keys(params).length === 0)
          return desktopAgentToolPolicy()
        if (method === 'agent.log.append') {
          if (typeof params.diagnostic !== 'boolean' || typeof params.line !== 'string'
            || params.line.length > 16_384 || !/^[^\r\n]+\n$/.test(params.line))
            throw new DesktopError('invalid_request', 'Agent 日志记录无效')
          const append = params.diagnostic ? agentLogSinks.diagnostic : agentLogSinks.regular
          append(params.line)
          return null
        }
        if (method === 'agent.memory.resolveReflectionModel' && Object.keys(params).length === 2)
          return agentModel.resolveReflectionModel(params.modelIdentity, params.modelId)
        if (method === 'agent.memory.resolveEmbedding' && Object.keys(params).length === 0)
          return await resolveEmbedding() ?? null
        if (method === 'network.resolveProxy') return await resolveSystemProxy(params.origin) ?? null
        if ((method === 'agent.search.deep_research.available' || method === 'agent.search.similar_image_search.available')
          && Object.keys(params).length === 0) {
          const session = await remoteSessionStore.read()
          return session ? remoteSearchAvailable(session,
            method === 'agent.search.deep_research.available' ? 'deep-research' : 'similar-image', signal) : false
        }
        if (method === 'agent.search.deep_research') {
          const parsed = desktopDeepResearchInput.safeParse(params)
          if (!parsed.success) throw new DesktopError('invalid_request', '深度研究请求无效')
          const session = await remoteSessionStore.read()
          if (!session) throw new DesktopError('closed', '请先登录远程服务器以使用深度研究')
          try { return await remoteDeepResearch(session, parsed.data, signal) }
          catch (error) {
            signal.throwIfAborted()
            if (error instanceof RemoteAgentSearchError)
              throw new DesktopError('storage_error', error.message)
            throw new DesktopError('storage_error', '远程深度研究暂不可用，请稍后重试')
          }
        }
        if (method === 'agent.search.similar_image_search') {
          const parsed = desktopSimilarImageHostInput.safeParse(params)
          if (!parsed.success) throw new DesktopError('invalid_request', '相似图片搜索请求无效')
          const session = await remoteSessionStore.read()
          if (!session) throw new DesktopError('closed', '请先登录远程服务器以使用相似图片搜索')
          try {
            if (!('attach_id' in parsed.data)) return await remoteSimilarImageSearch(session, parsed.data, signal)
            const { attach_id, ...fields } = parsed.data
            const image = await readDesktopAgentAttachment(host, dataDirectory, attach_id, MAX_DESKTOP_SEARCH_IMAGE_BYTES)
            signal?.throwIfAborted()
            return await remoteSimilarImageSearch(session, { ...fields, image_base64: Buffer.from(image.data).toString('base64') }, signal)
          }
          catch (error) {
            signal.throwIfAborted()
            if (error instanceof DesktopError) throw error
            if (error instanceof RemoteAgentSearchError)
              throw new DesktopError(error.code, error.message)
            throw new DesktopError('storage_error', '远程相似图片搜索暂不可用，请稍后重试')
          }
        }
        if (method === 'agent.files.globalSearch') {
          const { queries, mode, perType } = params
          if (!Array.isArray(queries) || queries.length > 8
            || queries.some(term => typeof term !== 'string' || !term.trim() || [...term].length > 64)
            || (mode !== 'OR' && mode !== 'AND') || typeof perType !== 'number' || !Number.isInteger(perType) || perType < 1 || perType > 20)
            throw new DesktopError('invalid_request', '文件搜索参数无效')
          return files.globalFileSearch(queries, mode, perType, signal)
        }
        if (method === 'agent.files.downloadTarget' && Object.keys(params).length === 0)
          return files.agentDownloadTarget()
        if (method === 'agent.files.commitDownload') return files.agentCommitDownload(dataDirectory, params, signal)
        if (method === 'agent.files.saveAttachment')
          return files.agentSaveAttachment(params, signal ?? AbortSignal.timeout(30_000))
        if (method === 'agent.files.workspaceList' && Object.keys(params).length === 0)
          return files.handlers[DESKTOP_CHANNELS.files]!({ action: 'workspace-list' })
        if (method === 'agent.files.overview' && Object.keys(params).length === 0)
          return files.agentOverview()
        if (method === 'agent.files.projectOverview' && Object.keys(params).length === 1
          && typeof params.projectId === 'number' && Number.isSafeInteger(params.projectId) && params.projectId > 0)
          return files.agentProjectFileOverview(params.projectId, signal)
        if (method === 'agent.files.searchReferences' && Object.keys(params).length === 1
          && typeof params.query === 'string' && params.query.length <= 4096)
          return files.handlers[DESKTOP_CHANNELS.files]!({ action: 'search', query: params.query })
        if (method === 'agent.files.resolveWorkspaceReference' && Object.keys(params).length === 1 && typeof params.id === 'string')
          return files.resolveWorkspaceReference(params.id)
        if (method === 'agent.files.resolveDroppedReference' && Object.keys(params).length === 1 && typeof params.id === 'string')
          return droppedReferences.resolve(params.id)
        if (method === 'agent.files.resolve' && Object.keys(params).length === 1 && typeof params.path === 'string')
          return files.agentResolveFile(params.path)
        if (method === 'agent.files.present' && typeof params.path === 'string'
          && (params.referenceOnly === undefined || params.referenceOnly === true)
          && Object.keys(params).length === (typeof params.referenceId === 'string' || typeof params.hostIdentity === 'string' ? 2 : 1)
            + Number(params.referenceOnly === true)) {
          try {
            let file
            if (typeof params.hostIdentity === 'string') {
              file = await files.resolveHostPresentation(params.path, params.hostIdentity)
              if (!file) {
                signal.throwIfAborted()
                const { path, hostIdentity } = params
                const extension = extname(path)
                const ext = extension.slice(1)
                const name = basename(path, extension)
                const reference = await droppedReferences.create(path, hostIdentity)
                if (params.referenceOnly) return { opened: true, name, ext, path, referenceId: reference.id }
                const system = shouldOpenFileInSystem(fileOpenPreference, ext)
                if (system) {
                  if (await shell.openPath(path)) return { error: '无法用系统默认应用打开本机文件' }
                } else {
                  if (!previewWindows) return { error: '文件预览窗口尚未就绪' }
                  await previewWindows.openExternal({ displayName: name, ext },
                    range => files.hostPresentationContent(path, hostIdentity, range),
                    async () => {
                      await files.resolveHostPresentation(path, hostIdentity)
                      shell.showItemInFolder(path)
                    })
                }
                return { opened: true, name, ext, path, system, referenceId: reference.id }
              }
            } else {
              const result = await files.resolvePresentation(params.path, typeof params.referenceId === 'string' ? params.referenceId : undefined)
              if (!result.preview) return { error: result.error }
              file = result.preview
            }
            signal.throwIfAborted()
            const name = file.ext ? file.displayName.slice(0, -(file.ext.length + 1)) : file.displayName
            const referenceId = encodeWorkspaceFileReferenceId(file.workspaceFile)
            const target = await files.resolveWorkspaceReference(referenceId)
            if (!target) return { error: '文件已移动或不可访问' }
            signal.throwIfAborted()
            const result = { opened: true, name, ext: file.ext, path: target.path, referenceId }
            if (params.referenceOnly) return result
            const system = shouldOpenFileInSystem(fileOpenPreference, file.ext, file.mimeType)
            if (system) {
              const { directoryId, relativePath: path, identity } = file.workspaceFile
              await files.handlers[DESKTOP_CHANNELS.files]!({ action: 'open', directoryId, path, identity })
            } else {
              if (!previewWindows) return { error: '文件预览窗口尚未就绪' }
              await previewWindows.open({ ...file, displayName: name })
            }
            return { ...result, system }
          } catch (error) {
            signal.throwIfAborted()
            if (error instanceof DesktopError) return { error: error.message }
            if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
              return { error: '文件已移动或不可访问' }
            throw error
          }
        }
        if (method === 'agent.im.sendAttachment') return imAttachments.send(params, signal, files.agentReadSendFile)
        if (method === 'agent.im.authorizeGroupTool') {
          const groupGateway = params.platform === 'feishu' ? feishuGateway : params.platform === 'telegram' ? gateway : params.platform === 'qq' ? qqGateway : undefined
          return groupGateway && 'authorizeGroupTool' in groupGateway ? groupGateway.authorizeGroupTool(params, signal) : false
        }
        if (method === 'agent.im.readGroupMemoryContext' && typeof params.ownerId === 'string') {
          const groupGateway = params.platform === 'feishu' ? feishuGateway : params.platform === 'telegram' ? gateway : params.platform === 'qq' ? qqGateway : undefined
          return groupGateway && 'readGroupMemoryContext' in groupGateway ? groupGateway.readGroupMemoryContext(params, signal) : null
        }
        if (method === 'agent.im.snapshot' && Object.keys(params).length === 0) {
          const [telegram, wechat, feishu, qq] = await Promise.all([
            gateway.snapshot(), wechatPairing.status(), feishuPairing.status(), qqPairing.status(),
          ])
          return {
            telegram: telegram.bound && telegram.status === 'connected',
            wechat: wechat.enabled && wechatGateway.health().running > 0,
            feishu: feishu.enabled && feishuGateway.health().running > 0,
            qq: qq.enabled && qq.bound && qqGateway.health().running > 0,
          }
        }
        throw new DesktopError('invalid_request', 'Agent 宿主能力无效')
      })
      await host.request('agent.sessions.recoverStartup')
      void host.request('agent.memory.resumeReflections').catch(() => {})
      async function fileContent(url: URL, range: string | null) {
        if (!url.searchParams.has('reference')) return files.content(url, range)
        const variant = url.searchParams.get('thumbnail') === '1' ? 'thumbnail' : 'metadata'
        const file = await droppedReferences.resolve(url.searchParams.get('reference'))
        if (!file) return new Response(null, { status: 404 })
        return files.hostPresentationContent(file.path, file.fileIdentity, null, variant)
      }
      protocol.handle('gugu-desktop', async (request) => {
        if (request.method !== 'GET') return new Response('界面资源不可用', { status: 405 })
        try {
          const url = new URL(request.url)
          const previewToken = /^\/__local-files\/preview\/([a-f0-9-]{36})$/u.exec(url.pathname)?.[1]
          if (url.host === 'app' && (url.pathname === '/__local-files/content' || previewToken)) {
            const origin = request.headers.get('origin')
            const trustedOrigin = devUiUrl ? new URL(devUiUrl).origin : 'gugu-desktop://app'
            if (origin && origin !== trustedOrigin) return new Response(null, { status: 403 })
            const range = request.headers.get('range')
            const response = previewToken
              ? await previewWindows?.content(previewToken, range) ?? new Response(null, { status: 404 })
              : await fileContent(url, range)
            if (origin) response.headers.set('Access-Control-Allow-Origin', trustedOrigin)
            return response
          }
          return await net.fetch(
            pathToFileURL(await uiResourcePath(request.url, resolve(uiPath, '..'))).href,
          )
        } catch {
          return new Response('界面资源不可用', { status: 404 })
        }
      })
      const preload = join(app.getAppPath(), 'dist/preload/index.cjs')
      const mainWindowSize = createMainWindowSizeStore(dataDirectory)
      let mainWindow: BrowserWindow | undefined
      host.onAgentRunChanged(sessionId => {
        if (mainWindow && !mainWindow.isDestroyed())
          mainWindow.webContents.send(DESKTOP_CHANNELS.agentRunChanged, sessionId)
      })
      const createWindow = async () => {
        const size = smoke ? undefined : mainWindowSize.read()
        const window = new BrowserWindow(
          windowOptions(preload, smoke, size ? { size, workArea: screen.getPrimaryDisplay().workAreaSize } : undefined),
        )
        mainWindow = window
        if (!smoke) window.on('close', () => {
          try {
            mainWindowSize.save(window.getNormalBounds())
          } catch {
            console.warn('无法保存主窗口尺寸')
          }
        })
        window.once('closed', () => { if (mainWindow === window) mainWindow = undefined })
        secureWindow(window, url => {
          void shell.openExternal(url).catch(() => { console.warn('无法打开外部链接') })
        })
        await window.loadURL(devUiUrl ?? uiUrl)
        return window
      }
      const handlers = {
        ...desktopLogHandlers(dataDirectory),
        [DESKTOP_CHANNELS.createDroppedFileReference]: (path: unknown) => {
          if (typeof path !== 'string') throw new DesktopError('invalid_request', '文件路径无效')
          return droppedReferences.create(path)
        },
        [DESKTOP_CHANNELS.openDroppedFileReference]: droppedReferences.open,
        ...workspaceHandlers(host, () => sandboxDiagnostics(host, report), files.globalFileSearch, async id => {
          const file = id.startsWith('drop-') ? await droppedReferences.resolve(id) : await files.resolveWorkspaceReference(id)
          return file ? Array.from(basename(file.path)).slice(0, 255).join('') : null
        }),
        [DESKTOP_CHANNELS.updateAppearance]: async (patch: unknown) => {
          const updated = await host.request<DesktopAppearancePreferences>('preferences.desktop.update', { patch })
          useSystemProxy = updated.useSystemProxy === true
          fileOpenPreference = updated.fileOpenPreference
          return updated
        },
        ...resourceHandlers(host, resolveModelProxy),
        ...agentSessionHandlers(host, agentModel, event => {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(DESKTOP_CHANNELS.agentChatEvent, event)
        }, resolveEmbedding,
          attachIds => removeDesktopAgentAttachmentFiles(dataDirectory, attachIds)),
        ...agentAttachments,
        ...telegramHandlers(gateway),
        ...pairingHandlers('wechat', wechatPairing, wechatGateway.health),
        ...pairingHandlers('feishu', feishuPairing, feishuGateway.health),
        ...pairingHandlers('qq', qqPairing, qqGateway.health),
        ...agentModelHandlers(agentModel),
        ...auxiliaryModelHandlers(dataDirectory, safeStorage, resolveModelProxy,
          () => host.request('agent.memory.invalidateEmbedding')),
        ...files.handlers,
        ...desktopMail.handlers,
        ...desktopTerminalHandlers(host, files.personalRoot),
        ...scheduleHandlers(host, deliverLocalReminder),
        ...createRemoteAccountHandlers(remoteSessionStore, createRemoteAuthClient(remoteFetch), createRemoteByokClient(remoteFetch)),
      }
      if (devUiUrl && previewSocket && previewSecret) {
        const previewAgent = await startDesktopPreviewAgent(previewSocket, previewSecret, handlers, () => app.quit(),
          listener => host.onAgentRunChanged(listener),
          devNode ? async () => {
            if (closing) throw new DesktopError('closed', '桌面应用正在退出')
            stopReminders?.()
            try {
              await host.pause()
              await host.start()
              if (!closing) startReminders()
              void host.request('agent.memory.resumeReflections').catch(() => {})
            } catch (error) {
              report('host.start_failed', { error })
              throw error
            }
          } : undefined, { ...files, content: fileContent })
        app.once('before-quit', () => {
          previewAgent.close()
          previewAgent.closeAllConnections()
        })
      }
      const projectWindows = registerProjectWindows({
        mainWindow: () => mainWindow, uiUrl: trustedUiUrl, preload, quitting: () => quitting,
        readProject,
      })
      const previewWindowManager = registerPreviewWindows({
        mainWindow: () => mainWindow, uiUrl: trustedUiUrl, preload,
        trustsProject: projectWindows.trusts,
        reference: command => files.handlers[DESKTOP_CHANNELS.files]!(command),
        reveal: ({ directoryId, relativePath: path, identity }) =>
          files.handlers[DESKTOP_CHANNELS.files]!({ action: 'reveal', directoryId, path, identity }),
      })
      previewWindows = previewWindowManager
      ipcMain.handle(DESKTOP_CHANNELS.startFileDrag, (event, directoryId: unknown, path: unknown, preview: unknown) => {
        const isTrusted = () => (!!mainWindow && trustedCaller(event, [mainWindow], trustedUiUrl))
          || projectWindows.trusts(event, DESKTOP_CHANNELS.startFileDrag, directoryId)
        return desktopReply(isTrusted(), async () => {
          const file = await files.resolveFileForDrag(directoryId, path)
          const cardImage = typeof preview === 'string' && preview.length <= 1_500_000 && preview.startsWith('data:image/png;base64,')
            ? nativeImage.createFromDataURL(preview) : undefined
          const icon = cardImage && !cardImage.isEmpty() ? cardImage : await app.getFileIcon(file, { size: 'normal' })
          if (!isTrusted()) throw new DesktopError('forbidden', '当前窗口无法拖出文件')
          if (icon.isEmpty()) throw new DesktopError('unsupported', '无法获取系统文件图标')
          event.sender.send(DESKTOP_CHANNELS.nativeFileDragSource, file)
          try { event.sender.startDrag({ file, icon }) }
          catch (error) {
            if (!event.sender.isDestroyed()) event.sender.send(DESKTOP_CHANNELS.nativeFileDragSource, null)
            throw error
          }
          return null
        })
      })
      registerDesktopIpc(ipcMain, handlers, {
        authorize: (event, channel, args) =>
          (!!mainWindow && trustedCaller(event, [mainWindow], trustedUiUrl))
          || projectWindows.trusts(event, channel, args[0])
          || previewWindowManager.trusts(event, channel, args[0]),
        onResult: (event, channel, result) => {
          if (channel === DESKTOP_CHANNELS.updateBoardProject)
            projectWindows.publishUpdate(event.sender, result as Parameters<typeof projectWindows.publishUpdate>[1])
        },
      })
      autoUpdater.autoDownload = false
      autoUpdater.autoInstallOnAppQuit = false
      autoUpdater.allowDowngrade = false
      autoUpdater.logger = null
      const updater = new DesktopUpdater(
        app.isPackaged && existsSync(join(resource, 'app-update.yml'))
          ? {
              check: async () => {
                await autoUpdater.netSession.setProxy({ mode: useSystemProxy ? 'system' : 'direct' })
                const result = await autoUpdater.checkForUpdates()
                return result?.isUpdateAvailable ? result.updateInfo.version : null
              },
              download: async () => {
                await autoUpdater.netSession.setProxy({ mode: useSystemProxy ? 'system' : 'direct' })
                await autoUpdater.downloadUpdate()
              },
              install: () => autoUpdater.quitAndInstall(false, true),
            }
          : null,
        () => host.close(),
      )
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: '咕咕',
            submenu: [
              {
                label: '检查更新',
                enabled: updater.status().state !== 'disabled',
                click: async () => {
                  try {
                    if (updater.status().state !== 'downloaded') {
                      await updater.check()
                      if (updater.status().state !== 'available') {
                        await dialog.showMessageBox({
                          message: '当前没有可用更新',
                        })
                        return
                      }
                      const download = await dialog.showMessageBox({
                        message: '发现新版本，是否下载更新？',
                        buttons: ['取消', '下载'],
                        defaultId: 0,
                        cancelId: 0,
                      })
                      if (download.response !== 1) return
                      await updater.download()
                    }
                    const install = await dialog.showMessageBox({
                      message: '更新已下载并校验。安装将关闭本地工作台，是否继续？',
                      buttons: ['稍后', '安装并重启'],
                      defaultId: 0,
                      cancelId: 0,
                    })
                    if (install.response === 1) await updater.install(true)
                  } catch {
                    await dialog.showMessageBox({
                      type: 'error',
                      message: '更新未完成，请重新启动当前版本后检查更新状态',
                    })
                  }
                },
              },
              { type: 'separator' },
              { role: 'quit', label: '退出' },
            ],
          },
          {
            label: '编辑',
            submenu: [
              { role: 'undo' },
              { role: 'redo' },
              { type: 'separator' },
              { role: 'cut' },
              { role: 'copy' },
              { role: 'paste' },
              { role: 'selectAll' },
            ],
          },
        ]),
      )
      function startReminders() {
        stopReminders?.()
        stopReminders = startLocalReminders(host, () => {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(DESKTOP_CHANNELS.scheduleChanged)
        }, error => report('scheduled_tasks.check_failed', { error }))
      }
      powerMonitor.on('suspend', () => {
        stopReminders?.()
        void host.pause().catch(error => report('host.stop_failed', { error }))
      })
      powerMonitor.on('resume', () => {
        void host.start().then(startReminders).catch(error => report('host.start_failed', { error }))
      })
      app.on('activate', () => {
        if (!quitting && !mainWindow) void createWindow()
      })
      await createWindow()
      startReminders()
      report('host.started')
    })
    .catch(async (error) => {
      report('host.start_failed', { error })
      stopReminders?.()
      for (const gateway of [telegram, wechat, feishu, qq])
        await gateway?.stop().catch(closeError => report('host.stop_failed', { error: closeError }))
      await lifecycle?.close().catch(closeError => report('host.stop_failed', { error: closeError }))
      if (!smoke)
        await dialog.showMessageBox({
          type: 'error',
          message:
            error instanceof DesktopError
              ? error.message
              : '桌面启动失败，请检查匹配的运行时制品与数据状态',
        })
      process.exitCode = 1
      quitting = true
      app.exit(1)
    })
}
