import { matchFolderSearchHits } from '@gugu/core'
import { desktopTrashTarget } from '../../../../packages/core/src/runtime/desktop-shell-trash.js'
import { applicationMenuChannels, type ApplicationMenuCommand } from '@gugu/desktop-contracts'
import { buildApplicationMenu, buildStatusMenu } from './application-menu.js'
import { createNativeFileDialogs } from './native-file-dialogs.js'
import { shouldOpenFileInSystem } from '@gugu/desktop-contracts/file-preview'
import { createGatewayPowerPolicy } from './im/gateway-power.js'
import { createDesktopImAttachmentSender } from './im/gateway/delivery/attachments.js'
import { createDesktopImCallback } from './im/gateway/interactions/callback.js'
import { createDesktopQqReferences } from './im/gateway/platforms/qq/references.js'
import { createDesktopQqGateway } from './im/gateway/platforms/qq/index.js'
import { createDesktopFeishuGateway } from './im/gateway/platforms/feishu/index.js'
import { createDesktopRecordingTranscriber } from './agent/voice-recording.js'
import { createDesktopWechatCursor, createDesktopWechatGateway, createDesktopWechatReach } from './im/gateway/platforms/wechat/index.js'
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
import { bindDesktopScheduledIm } from './schedules/im.js'
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
  Tray,
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
import { lstat, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import {
  CoreHost,
  verifyArtifact,
  desktopReply,
  DesktopError,
} from './core-host.js'
import { workspaceHandlers } from './workspace/ipc.js'
import { MAX_DESKTOP_SEARCH_IMAGE_BYTES } from '@gugu/core/agent/search-contracts'
import { createDesktopPaidSearchHost, isDesktopPaidSearchMethod } from './agent/paid-search-host.js'
import { createDesktopPersonalSmtp } from './mail/personal-smtp.js'
import { createDesktopMailService } from './mail/index.js'
import { createDesktopMailAttachmentResolver } from './mail/attachments.js'
import { registerDesktopIpc } from './ipc/register.js'
import { createRemoteSessionStore } from './auth/store.js'


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
  let tray: Tray | undefined
  let openMainWindow = () => {}
  let gatewayPower: ReturnType<typeof createGatewayPowerPolicy> | undefined
  let stopReminders: (() => void) | undefined
  app.on('before-quit', (event) => {
    if (quitting || !lifecycle) return
    event.preventDefault()
    if (closing) return
    closing = true
    gatewayPower?.close()
    if (tray && !tray.isDestroyed()) tray.destroy()
    stopReminders?.()
    const stopIm = Promise.allSettled([telegram?.stop(), wechat?.stop(), feishu?.stop(), qq?.stop()]).then(results => {
      for (const result of results) if (result.status === 'rejected') report('host.stop_failed', { error: result.reason })
    })
    void stopIm.then(() => lifecycle?.close()).then(() => report('host.stopped'), error => report('host.stop_failed', { error })).finally(() => {
      quitting = true
      app.quit()
    })
  })
  app.on('window-all-closed', () => { if (!tray) app.quit() })
  app.on('second-instance', () => openMainWindow())
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
          undefined, filesRoot, runtime.workerEntry, runtime.agentRuntimeModule, report,
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
      let keepGatewayOnline = networkPreferences.keepGatewayOnline !== false
      let suspended = false
      let sleepGeneration = 0
      let fileOpenPreference = networkPreferences.fileOpenPreference
      const resolveModelProxy = async (url: URL) => useSystemProxy ? resolveSystemProxy(url.origin) : undefined
      const remoteFetch: typeof fetch = (input, init) => useSystemProxy
        ? systemProxy.fetch(input instanceof URL ? input.href : input, init)
        : directDesktopFetch(input, init)
      const remoteSessionStore = createRemoteSessionStore(dataDirectory, safeStorage)
      const paidSearch = createDesktopPaidSearchHost(remoteSessionStore, remoteFetch, id =>
        readDesktopAgentAttachment(host, dataDirectory, id, MAX_DESKTOP_SEARCH_IMAGE_BYTES))
      const agentModel = createDesktopAgentModelService(createDesktopAgentModelStore(dataDirectory, safeStorage), resolveModelProxy)
      const admitIm = createDesktopImInbox(host, safeStorage, dataDirectory)
      const pendingImAsks = createDesktopImPendingAskStore(dataDirectory, safeStorage)
      const imAttachments = createDesktopImAttachmentSender(dataDirectory, safeStorage, error =>
        report('gateway.qq_upload_failed', { uploadStage: error.stage, httpStatus: error.statusCode, upstreamCode: error.errorCode }),
        (httpStatus, upstreamCode) => report('gateway.qq_file_message_failed', { httpStatus, upstreamCode }))
      const workspaceCommands = {
        list: () => files.agentWorkspaceList(),
        async remove(directoryId: string) {
          await files.handlers[DESKTOP_CHANNELS.files]!({ action: 'workspace-remove', directoryId })
          await host.request('agent.sessions.clearWorkspaceBindings', { directoryId })
        },
      }
      const dispatchIm = createDesktopImDispatch(host, safeStorage, agentModel, () => host.request<DesktopAppearancePreferences>('preferences.desktop.get'), (code, error, rpcMethod) => report('gateway.degraded', { code, error, rpcMethod }), imAttachments.register, workspaceCommands)
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
      const wechatReach = createDesktopWechatReach(dataDirectory, safeStorage)
      const wechatGateway = wechat = createDesktopWechatGateway(wechatPairing, admitIm, dispatchIm, newImTransport, createDesktopWechatCursor(dataDirectory, safeStorage), (code, error) => report('gateway.degraded', { code, error }), wechatReach, host)
      const feishuPairing = createDesktopFeishuPairing(dataDirectory, safeStorage, randomUUID(), newImTransport(), async () => {
        feishu?.refresh()
        await feishu?.settled()
      })
      const feishuGateway = feishu = createDesktopFeishuGateway(feishuPairing, admitIm, dispatchIm, newImTransport, undefined, callbackIm, imVoice, { host, encryption: safeStorage }, pendingImAsks)
      const qqPairing = createDesktopQqPairing(dataDirectory, safeStorage, randomUUID(), newImTransport(), () => qq?.refresh())
      const qqGateway = qq = createDesktopQqGateway(qqPairing, admitIm, dispatchIm, newImTransport, undefined, callbackIm,
        (code, error) => report('gateway.degraded', { code, error }), { host, encryption: safeStorage, dataDirectory, voice: imVoice, observeUpload: uploadMetrics => report('gateway.qq_upload_timing', { uploadMetrics }), references: createDesktopQqReferences(dataDirectory, safeStorage) })
      const scheduledIm = bindDesktopScheduledIm({ feishuPairing, qqPairing, wechatPairing, wechatReach, telegram: gateway, transport: newImTransport,
        async readScheduledGroup(params, signal) {
          const reader = params.platform === 'qq' ? qqGateway : params.platform === 'feishu' ? feishuGateway : params.platform === 'telegram' ? gateway : null
          return reader?.readScheduledGroup(params, signal) ?? null
        },
      })
      const gateways = [gateway, wechatGateway, feishuGateway, qqGateway]
      if (!smoke) {
        const power = gatewayPower = createGatewayPowerPolicy(() => !closing && !suspended && keepGatewayOnline
          && gateways.some(gateway => gateway.health().configured > 0))
        gateways.forEach(gateway => gateway.onConfigurationChanged(power.update))
      }
      const uiPath = app.isPackaged
        ? join(app.getAppPath(), 'ui/desktop.html')
        : resolve(app.getAppPath(), '../ui/dist-desktop/desktop.html')
      const uiUrl = DESKTOP_UI_URL
      const trustedUiUrl = devUiUrl ?? uiUrl
      const readProject = (id: number) => host.request<DesktopProjectDetails>('projects.board.get', { id })
      const readLifecycleProject = (id: number) => host.request<DesktopProjectDetails>('projects.board.get', { id, includeDeleted: true })
      const droppedReferences = createDroppedFileReferences(dataDirectory, path => shell.openPath(path))
      const fileDialogs = createNativeFileDialogs(() => mainWindow)
      const files = desktopFiles(filesRoot, {
        async save(name) {
          const result = await fileDialogs.save({ defaultPath: name })
          return result.canceled ? undefined : result.filePath
        },
        reveal(path) { shell.showItemInFolder(path) },
        open: path => shell.openPath(path),
        async pickDirectory() {
          const result = await fileDialogs.open({ properties: ['openDirectory', 'createDirectory'] })
          return result.canceled ? undefined : result.filePaths[0]
        },
        trash: path => shell.trashItem(path),
        async thumbnail(bytes, name) {
          const systemThumbnail = process.platform === 'darwin' || process.platform === 'win32'
          // JPEG 的方向可能由 EXIF 指定；系统缩略图会在转成 PNG 前应用它。
          if (!systemThumbnail || /\.png$/i.test(name)) {
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
      const personalSmtp = createDesktopPersonalSmtp(dataDirectory, safeStorage, async () => {
        const session = await remoteSessionStore.read()
        return session ? (await createRemoteAuthClient(remoteFetch).restore(session).catch(() => null))?.email ?? '' : ''
      })
      const desktopMail = createDesktopMailService(dataDirectory, safeStorage, undefined,
        createDesktopMailAttachmentResolver(async id => id.startsWith('drop-')
          ? droppedReferences.resolve(id) : files.resolveWorkspaceReference(id)), personalSmtp)
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
        if (method === 'agent.shell.trash') {
          const { path, identity, cwd, workspace } = params
          if (typeof path !== 'string' || !isAbsolute(path) || typeof identity !== 'string'
            || typeof cwd !== 'string' || !isAbsolute(cwd)
            || (workspace !== null && (typeof workspace !== 'string' || !isAbsolute(workspace))))
            throw new DesktopError('invalid_request', '废纸篓请求无效')
          const current = await desktopTrashTarget(path, cwd, workspace ?? undefined)
          if (current.path !== path || current.identity !== identity)
            throw new DesktopError('invalid_request', '废纸篓目标已经变化')
          signal.throwIfAborted()
          await shell.trashItem(path)
          return { ok: true }
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
        if (method.startsWith('agent.schedules.im.')) return scheduledIm(method, params, signal)
        if (method === 'agent.schedules.model' && Object.keys(params).length === 0) return agentModel.resolveRunModel()
        if (method === 'agent.memory.resolveReflectionModel' && Object.keys(params).length === 2)
          return agentModel.resolveReflectionModel(params.modelIdentity, params.modelId)
        if (method === 'agent.memory.resolveEmbedding' && Object.keys(params).length === 0)
          return await resolveEmbedding() ?? null
        if (method === 'network.resolveProxy') return await resolveSystemProxy(params.origin) ?? null
        if (isDesktopPaidSearchMethod(method)) return paidSearch(method, params, signal)
        if (method === 'agent.files.globalSearch') {
          const { queries, mode, perType } = params
          if (!Array.isArray(queries) || queries.length > 8
            || queries.some(term => typeof term !== 'string' || !term.trim() || [...term].length > 64)
            || (mode !== 'OR' && mode !== 'AND') || typeof perType !== 'number' || !Number.isInteger(perType) || perType < 1 || perType > 20)
            throw new DesktopError('invalid_request', '文件搜索参数无效')
          return files.globalFileSearch(queries, mode, perType, signal)
        }
        if (method === 'agent.files.downloadTarget' && (Object.keys(params).length === 0
          || Object.keys(params).length === 1 && typeof params.folderPath === 'string'))
          return files.agentDownloadTarget(params.folderPath)
        if (method === 'agent.files.commitDownload') return files.agentCommitDownload(dataDirectory, params, signal)
        if (method === 'agent.files.saveAttachment')
          return files.agentSaveAttachment(params, signal ?? AbortSignal.timeout(30_000))
        if (method === 'agent.files.workspaceInstructions' && Object.keys(params).length === 1
          && typeof params.directoryId === 'string' && /^[a-f0-9-]{36}$/iu.test(params.directoryId))
          return files.agentWorkspaceInstructions(params.directoryId)
        if (method === 'agent.files.projectWorkspaceBinding' && Object.keys(params).length === 3)
          return files.handlers[DESKTOP_CHANNELS.files]!({ action: 'project-workspace-binding',
            projectId: params.projectId, directoryId: params.directoryId, bound: params.bound })
        if (method === 'agent.files.workspaceList' && Object.keys(params).length === 0)
          return files.agentWorkspaceList()
        if (method === 'agent.files.overview' && Object.keys(params).length === 0)
          return files.agentOverview()
        if (method === 'agent.files.projectOverview' && Object.keys(params).length === 1
          && typeof params.projectId === 'number' && Number.isSafeInteger(params.projectId) && params.projectId > 0)
          return files.agentProjectFileOverview(params.projectId, signal)
        if (method === 'agent.files.projectPath' && Object.keys(params).length === 1
          && typeof params.projectId === 'number' && Number.isSafeInteger(params.projectId) && params.projectId > 0)
          return files.agentProjectFilePath(params.projectId)
        if (method === 'agent.files.searchReferences' && Object.keys(params).length === 1
          && typeof params.query === 'string' && params.query.length <= 4096)
          return files.handlers[DESKTOP_CHANNELS.files]!({ action: 'search', query: params.query })
        if (method === 'agent.files.workspaceRoot' && Object.keys(params).length === 1 && typeof params.directoryId === 'string')
          return files.agentWorkspaceRoot(params.directoryId)
        if (method === 'agent.files.resolveWorkspaceReference' && Object.keys(params).length === 1 && typeof params.id === 'string')
          return files.resolveWorkspaceReference(params.id)
        if (method === 'agent.files.resolveDroppedReference' && Object.keys(params).length === 1 && typeof params.id === 'string')
          return droppedReferences.resolve(params.id)
        if (method === 'agent.files.resolve' && Object.keys(params).length === 1 && typeof params.path === 'string')
          return files.agentResolveFile(params.path)
        if (method === 'agent.files.libraryFileReference' && Object.keys(params).length === 1
          && typeof params.path === 'string' && isAbsolute(params.path) && params.path.length <= 4096) {
          const path = params.path
          const { groups } = await files.globalFileSearch([path], 'OR', 1, signal)
          const hit = groups.find(group => group.type === 'file')?.items.find(item => item.path_file.location.value === path)
          if (!hit) return null
          const { directoryId, relativePath } = hit.path_file
          const reference = await files.handlers[DESKTOP_CHANNELS.files]!({ action: 'reference', directoryId, path: relativePath })
          if (!reference || typeof reference !== 'object' || !('id' in reference) || typeof reference.id !== 'string') return null
          const file = await files.resolveWorkspaceReference(reference.id)
          signal.throwIfAborted()
          return file?.path === path ? reference.id : null
        }
        if (method === 'agent.files.deleteItem') {
          const { path, kind, expected } = params
          if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096
            || (kind !== 'file' && kind !== 'folder') || (expected !== undefined && typeof expected !== 'string')
            || Object.keys(params).length !== (expected === undefined ? 2 : 3))
            throw new DesktopError('invalid_request', '废纸篓请求无效')
          const { groups } = await files.globalFileSearch([path], 'OR', 2, signal)
          const hit = groups.find(group => group.type === kind)?.items.find(item =>
            item.path_file.relativePath && item.path_file.location.value === path)
          if (!hit) return null
          const { directoryId, relativePath } = hit.path_file
          const reference = await files.handlers[DESKTOP_CHANNELS.files]!({ action: 'reference', directoryId, path: relativePath, kind })
          if (!reference || typeof reference !== 'object' || !('id' in reference) || typeof reference.id !== 'string') return null
          const item = await files.resolveWorkspaceReference(reference.id)
          if (!item || item.path !== path) return null
          const target = await desktopTrashTarget(path, dirname(path))
          const info = await lstat(path, { bigint: true })
          if (target.path !== path || [info.dev, info.ino, info.birthtimeNs].join('.') !== item.fileIdentity
            || (kind === 'folder' ? !info.isDirectory() : !info.isFile())
            || [info.dev, info.ino, info.mode, info.ctimeNs].join(':') !== target.identity) return null
          const version = JSON.stringify([reference.id, target.identity])
          if (expected === undefined) return version
          if (version !== expected) return null
          signal.throwIfAborted()
          await shell.trashItem(path)
          return true
        }
        if (method === 'agent.files.openFolder' && Object.keys(params).length === 2
          && typeof params.path === 'string' && params.path.length <= 4096 && typeof params.referenceOnly === 'boolean') {
          const query = params.path
          if (isAbsolute(query)) {
            try {
              const { path, referenceId, name } = await files.resolveAgentFolderPath(query)
              signal.throwIfAborted()
              if (!params.referenceOnly && await shell.openPath(path)) return { error: '无法打开文件夹' }
              return { file: { name, ext: '', referenceId, surface: 'system', location: { kind: 'host_absolute', value: path } } }
            } catch (error) {
              if (error instanceof DesktopError && ['invalid_request', 'forbidden', 'not_found'].includes(error.code))
                return { error: error.message }
              if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
                return { error: '文件夹不存在或已移动' }
              throw error
            }
          }
          const { groups, partial } = await files.globalFileSearch([query], 'OR', 20, signal)
          const matches = matchFolderSearchHits(query, groups.find(group => group.type === 'folder')?.items.filter(hit => 'link' in hit && hit.link) ?? [])
          const item = matches.length === 1 && !partial ? matches[0] : undefined
          const referenceId = item && 'link' in item && typeof item.link === 'string' ? item.link.split('/').at(-1) : undefined
          const folder = referenceId ? await files.resolveWorkspaceReference(referenceId) : null
          signal.throwIfAborted()
          if (!folder || folder.type !== 'folder' || !item || folder.path !== item.path_file.location.value) return {
            error: matches.length > 1 ? `找到多个同名文件夹，请选择准确路径：${matches.slice(0, 5).map(hit => hit.path_file.location.value).join('、')}`
              : '未找到可确认的唯一文件夹，请提供准确路径',
          }
          if (!params.referenceOnly && await shell.openPath(folder.path)) return { error: '无法打开文件夹' }
          return { file: { name: item.title, ext: '', referenceId, surface: 'system', location: { kind: 'host_absolute', value: folder.path } } }
        }
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
        if (method === 'agent.im.sendAttachment') {
          const isQq = params.platform === 'qq'
          if (isQq) report('gateway.qq_file_delivery_started')
          const outcome = await imAttachments.send(params, signal, files.agentReadSendFile)
          if (isQq) report('gateway.qq_file_delivery_result', { deliveryOutcome: outcome })
          return outcome
        }
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
      let mainWindowLoad: Promise<void> | undefined
      host.onAgentRunChanged((sessionId, _runId, interactionChanged) => {
        if (mainWindow && !mainWindow.isDestroyed())
          mainWindow.webContents.send(DESKTOP_CHANNELS.agentRunChanged, sessionId, interactionChanged)
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
        window.once('closed', () => {
          if (mainWindow !== window) return
          mainWindow = undefined
          mainWindowLoad = undefined
        })
        secureWindow(window, url => {
          void shell.openExternal(url).catch(() => { console.warn('无法打开外部链接') })
        })
        try {
          mainWindowLoad = window.loadURL(devUiUrl ?? uiUrl)
          await mainWindowLoad
          return window
        } catch (error) {
          if (window.isDestroyed()) return window
          window.destroy()
          throw error
        }
      }
      openMainWindow = () => {
        if (closing || quitting) return
        if (process.platform === 'darwin') app.show()
        if (!mainWindow) {
          void createWindow().catch(error => report('host.start_failed', { error }))
          return
        }
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.show()
        mainWindow.focus()
      }
      async function sendMenuCommand(command: ApplicationMenuCommand) {
        if (closing || quitting) return
        openMainWindow()
        const target = mainWindow
        await mainWindowLoad
        if (target && target === mainWindow && !target.isDestroyed()) {
          target.webContents.send(applicationMenuChannels.command, command)
        }
      }
      function runMenuCommand(command: ApplicationMenuCommand) {
        void sendMenuCommand(command).catch(error => report('host.start_failed', { error }))
      }
      let pendingArchive: { id: string; path: string; digest: string } | undefined
      let handlingArchive = false
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
        [DESKTOP_CHANNELS.deleteBoardProject]: (id: unknown) =>
          files.changeProjectDirectory(id, 'delete', () => host.request('projects.board.delete', { id }), readLifecycleProject),
        [DESKTOP_CHANNELS.restoreBoardProject]: (id: unknown) =>
          files.changeProjectDirectory(id, 'restore', () => host.request('projects.board.restore', { id }), readLifecycleProject),
        [DESKTOP_CHANNELS.purgeBoardProject]: (id: unknown) =>
          files.changeProjectDirectory(id, 'purge', () => host.request('projects.board.purge', { id }), readLifecycleProject),
        [DESKTOP_CHANNELS.updateAppearance]: async (patch: unknown) => {
          const updated = await host.request<DesktopAppearancePreferences>('preferences.desktop.update', { patch })
          useSystemProxy = updated.useSystemProxy === true
          fileOpenPreference = updated.fileOpenPreference
          keepGatewayOnline = updated.keepGatewayOnline !== false
          gatewayPower?.update()
          return updated
        },
        ...resourceHandlers(host, resolveModelProxy),
        ...agentSessionHandlers(host, agentModel, event => {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(DESKTOP_CHANNELS.agentChatEvent, event)
        }, resolveEmbedding,
          attachIds => removeDesktopAgentAttachmentFiles(dataDirectory, attachIds), workspaceCommands),
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
        [DESKTOP_CHANNELS.preflightBusinessArchive]: async () => {
          if (handlingArchive) throw new DesktopError('conflict', '正在处理另一个归档')
          handlingArchive = true
          pendingArchive = undefined
          try {
            const options: Electron.OpenDialogOptions = {
              properties: ['openFile'], filters: [{ name: 'ZIP', extensions: ['zip'] }],
            }
            const selected = await fileDialogs.open(options)
            const path = selected.filePaths[0]
            if (selected.canceled || !path) return null
            const { digest, added, skipped } = await host.request<{ digest: string; added: number; skipped: number }>(
              'preferences.preflightBusinessArchive', { path })
            const id = randomUUID()
            pendingArchive = { id, path, digest }
            return { id, added, skipped }
          } finally { handlingArchive = false }
        },
        [DESKTOP_CHANNELS.applyBusinessArchive]: async (id: unknown) => {
          if (handlingArchive || !pendingArchive || pendingArchive.id !== id)
            throw new DesktopError('conflict', '请重新预检需要导入的归档')
          const { path, digest } = pendingArchive
          handlingArchive = true
          try {
            const { added, skipped } = await host.request<{ added: number; skipped: number }>(
              'preferences.applyBusinessArchive', { path, digest })
            pendingArchive = undefined
            return { added, skipped }
          } finally { handlingArchive = false }
        },
        [DESKTOP_CHANNELS.exportBusinessArchive]: async () => {
          const options = { defaultPath: `gugu-export-${randomUUID().slice(0, 12)}.zip`, filters: [{ name: 'ZIP', extensions: ['zip'] }] }
          const result = await fileDialogs.save(options)
          if (result.canceled || !result.filePath) return null
          const directory = await mkdtemp(join(dirname(result.filePath), '.gugu-export-'))
          const temporary = join(directory, 'archive.zip')
          try {
            await host.request('preferences.exportBusinessArchive', { path: temporary })
            await rename(temporary, result.filePath)
          } catch (error) {
            if (error instanceof DesktopError) throw error
            throw new DesktopError('storage_error', '归档保存失败')
          } finally {
            await rm(directory, { recursive: true, force: true }).catch(() => {})
          }
          return null
        },
        [DESKTOP_CHANNELS.personalSmtp]: personalSmtp.command,
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
          } : undefined, { ...files, content: fileContent }, (method, params, signal) => {
            if (method === 'agent.schedules.im.groupCatalog')
              return host.request('schedules.groupCatalog', { platform: params.platform })
            return scheduledIm(method, params, signal)
          })
        app.once('before-quit', () => {
          previewAgent.close()
          previewAgent.closeAllConnections()
        })
      }
      const projectWindows = registerProjectWindows({
        mainWindow: () => mainWindow, uiUrl: trustedUiUrl, preload, quitting: () => quitting,
        readProject, dataDirectory, isWorkspaceBoundToProject: files.isWorkspaceBoundToProject,
      })
      const previewWindowManager = registerPreviewWindows({
        mainWindow: () => mainWindow, uiUrl: trustedUiUrl, preload,
        trustsProject: projectWindows.trusts,
        reference: command => files.handlers[DESKTOP_CHANNELS.files]!(command),
        resolveLibraryPath: files.resolvePresentation,
        readAttachment: id => readDesktopAgentAttachment(host, dataDirectory, id),
        reveal: ({ directoryId, relativePath: path, identity }) =>
          files.handlers[DESKTOP_CHANNELS.files]!({ action: 'reveal', directoryId, path, identity }),
      })
      previewWindows = previewWindowManager
      ipcMain.handle(DESKTOP_CHANNELS.startFileDrag, (event, directoryId: unknown, path: unknown, preview: unknown) => {
        const isTrusted = async () => (!!mainWindow && trustedCaller(event, [mainWindow], trustedUiUrl))
          || projectWindows.trusts(event, DESKTOP_CHANNELS.startFileDrag, directoryId)
        return desktopReply(isTrusted(), async () => {
          const file = await files.resolveFileForDrag(directoryId, path)
          const cardImage = typeof preview === 'string' && preview.length <= 1_500_000 && preview.startsWith('data:image/png;base64,')
            ? nativeImage.createFromDataURL(preview) : undefined
          const icon = cardImage && !cardImage.isEmpty() ? cardImage : await app.getFileIcon(file, { size: 'normal' })
          if (!await isTrusted()) throw new DesktopError('forbidden', '当前窗口无法拖出文件')
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
        authorize: async (event, channel, args) =>
          (!!mainWindow && trustedCaller(event, [mainWindow], trustedUiUrl))
          || await projectWindows.trusts(event, channel, args[0])
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
      async function checkForUpdates() {
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
      }
      Menu.setApplicationMenu(Menu.buildFromTemplate(buildApplicationMenu({
        mac: process.platform === 'darwin',
        canUpdate: updater.status().state !== 'disabled',
        checkForUpdates,
        sendCommand: runMenuCommand,
      })))
      function startReminders() {
        stopReminders?.()
        stopReminders = startLocalReminders(host, () => {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(DESKTOP_CHANNELS.scheduleChanged)
        }, error => report('scheduled_tasks.check_failed', { error }))
      }
      let sleepTransition = Promise.resolve()
      powerMonitor.on('suspend', () => {
        if (closing || suspended) return
        suspended = true
        sleepGeneration++
        gatewayPower?.release()
        stopReminders?.()
        const draining = Promise.all(gateways.map(gateway => gateway.suspend()))
        sleepTransition = sleepTransition.then(async () => {
          await draining
          if (!closing) await host.pause()
        }).catch(error => report('host.stop_failed', { error }))
      })
      powerMonitor.on('resume', () => {
        if (closing || !suspended) return
        const generation = sleepGeneration
        void sleepTransition.then(async () => {
          if (closing || generation !== sleepGeneration || !suspended) return
          await host.start()
          if (closing || generation !== sleepGeneration || !suspended) return
          suspended = false
          gatewayPower?.update()
          startReminders()
          if (!smoke) await Promise.all(gateways.map(gateway => gateway.resume()))
        }).catch(error => report('host.start_failed', { error }))
      })
      app.on('activate', () => openMainWindow())
      if (process.platform === 'darwin' || process.platform === 'win32') {
        const assets = join(app.getAppPath(), 'assets')
        const icon = nativeImage.createFromPath(join(assets, 'icon.png'))
        const trayIcon = process.platform === 'darwin'
          ? nativeImage.createFromPath(join(assets, 'trayTemplate.png'))
          : icon.resize({ width: 16 })
        if (process.platform === 'darwin') {
          trayIcon.setTemplateImage(true)
          if (!app.isPackaged) app.dock?.setIcon(nativeImage.createFromPath(join(assets, 'icon-macos.png')))
        }
        tray = new Tray(trayIcon)
        tray.setToolTip('咕咕')
        tray.setContextMenu(Menu.buildFromTemplate(buildStatusMenu(
          process.platform === 'darwin', openMainWindow, () => runMenuCommand('new-note'),
        )))
        if (process.platform === 'win32') tray.on('click', openMainWindow)
      }
      if (mainWindow) await mainWindowLoad
      else await createWindow()
      startReminders()
      report('host.started')
      if (!smoke && !closing) {
        for (const gateway of gateways)
          void Promise.resolve().then(() => gateway.start()).catch(error => report('gateway.degraded', { error }))
      }
    })
    .catch(async (error) => {
      gatewayPower?.close()
      if (tray && !tray.isDestroyed()) tray.destroy()
      report('host.start_failed', { error })
      stopReminders?.()
      for (const gateway of [telegram, wechat, feishu, qq])
        await gateway?.stop().catch(closeError => report('host.stop_failed', { error: closeError }))
      await lifecycle?.close().catch(closeError => report('host.stop_failed', { error: closeError }))
      if (devUiUrl && previewSocket)
        console.error('桌面预览启动失败：' + (error instanceof DesktopError ? error.code : 'internal_error'))
      else if (!smoke)
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
