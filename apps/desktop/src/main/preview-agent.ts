import { filesPreviewRoute, resourcesPreviewRoute, workspacePreviewRoutes, agentModelPreviewPath, agentSessionPreviewPath, previewAttachmentPath } from '@gugu/desktop-contracts'
import { streamPreviewRunChanges } from './agent/preview-run-changes.js'
import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { DESKTOP_CHANNELS, MAX_FRAME } from '@gugu/core/desktop'
import { encodeAgentChatSse } from '@gugu/core/agent/chat-sse'
import { DesktopError, desktopReply } from './core-host.js'
import { handlePreviewAttachment } from './agent/preview-attachments.js'
import { servePreviewFile } from './files/preview.js'
import type { IpcHandlers } from './ipc/types.js'

export async function startDesktopPreviewAgent(socket: string, secret: string, handlers: IpcHandlers, quitForReload?: () => void,
  subscribeRunChanges?: Parameters<typeof streamPreviewRunChanges>[1],
  reloadCore?: () => Promise<void>,
  files?: Parameters<typeof servePreviewFile>[2],
  scheduledIm?: ReturnType<typeof import('./schedules/im.js').bindDesktopScheduledIm>,
) {
  const expected = Buffer.from(secret)
  const channels = new Map<string, ReadonlyMap<string, string>>([
    ['/__desktop-preview/im', new Map([['qqPairing', DESKTOP_CHANNELS.qqPairing], ['feishuPairing', DESKTOP_CHANNELS.feishuPairing], ['wechatPairing', DESKTOP_CHANNELS.wechatPairing], ['telegramGateway', DESKTOP_CHANNELS.telegramGateway]])],
    ['/__desktop-preview/preferences', new Map([['appearance', DESKTOP_CHANNELS.appearance], ['updateAppearance', DESKTOP_CHANNELS.updateAppearance], ['agentPreference', DESKTOP_CHANNELS.agentPreference], ['personalSmtp', DESKTOP_CHANNELS.personalSmtp], ['remoteAccount', DESKTOP_CHANNELS.remoteAccount], ['remoteLogin', DESKTOP_CHANNELS.remoteLogin], ['remoteLogout', DESKTOP_CHANNELS.remoteLogout], ['remoteByok', DESKTOP_CHANNELS.remoteByok], ['agentUsage', DESKTOP_CHANNELS.agentUsage], ['dataInventory', DESKTOP_CHANNELS.dataInventory], ['exportBusinessArchive', DESKTOP_CHANNELS.exportBusinessArchive], ['preflightBusinessArchive', DESKTOP_CHANNELS.preflightBusinessArchive], ['applyBusinessArchive', DESKTOP_CHANNELS.applyBusinessArchive], ['clearAgentMemory', DESKTOP_CHANNELS.clearAgentMemory], ['clearAgentAttachments', DESKTOP_CHANNELS.clearAgentAttachments]])],
    ['/__desktop-preview/logs', new Map([['readLogs', DESKTOP_CHANNELS.readLogs]])],
    ...[filesPreviewRoute, resourcesPreviewRoute, ...workspacePreviewRoutes].map(({ endpoint, methods }) => [endpoint,
      new Map<string, string>(methods.map(method => [method, DESKTOP_CHANNELS[method]])),
    ] as const),
    [agentModelPreviewPath, new Map([['agentModel', DESKTOP_CHANNELS.agentModel], ['auxiliaryModel', DESKTOP_CHANNELS.auxiliaryModel]])],
    [agentSessionPreviewPath, new Map([['agentSessions', DESKTOP_CHANNELS.agentSessions]])],
  ])
  const server = createServer(async (req, res) => {
    const received = Buffer.from(req.headers.authorization ?? '')
    const route = channels.get(req.url ?? '')
    const attachment = req.url === previewAttachmentPath
    const fileContent = files && req.url?.startsWith('/__local-files/content?')
    const fileUpload = files && req.url?.startsWith('/__local-files/upload?')
    const permitted = fileContent ? req.method === 'GET' : req.method === 'POST'
      && (req.headers['content-type'] === 'application/json' && !fileUpload
        || (attachment || fileUpload) && req.headers['content-type'] === 'application/octet-stream')
    if (!permitted || received.length !== expected.length || !timingSafeEqual(received, expected)) {
      res.writeHead(403).end()
      return
    }
    if (files && (fileContent || fileUpload)) {
      await servePreviewFile(req, res, files, fileContent ? 'content' : 'upload')
      return
    }
    if (req.url === '/__desktop-preview/reload' && quitForReload) {
      res.writeHead(202).end(quitForReload)
      return
    }
    if (req.url === '/__desktop-preview/reload-core' && reloadCore) {
      const reply = await desktopReply(true, reloadCore)
      res.writeHead(reply.ok ? 204 : 503).end()
      return
    }
    if (attachment) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      const reply = await desktopReply(true, () => handlePreviewAttachment(req, handlers))
      res.end(JSON.stringify(reply))
      return
    }
    const internalSchedule = req.url === '/__desktop-preview/internal-scheduled-im' && scheduledIm
    if (!route && !internalSchedule) {
      res.writeHead(403).end()
      return
    }
    const streaming = req.url === agentSessionPreviewPath && req.headers.accept === 'text/event-stream'
    res.setHeader('Content-Type', streaming ? 'text/event-stream' : 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    const connection = new AbortController()
    res.once('close', () => connection.abort())
    const emit = (event: Parameters<typeof encodeAgentChatSse>[0]) => {
      if (!res.destroyed) res.write(encodeAgentChatSse(event))
    }
    const reply = await desktopReply(true, async () => {
      let size = 0
      const chunks: Buffer[] = []
      for await (const chunk of req) {
        size += chunk.length
        if (size > (req.url === '/__desktop-preview/preferences' ? MAX_FRAME : MAX_FRAME / 2)) throw new DesktopError('invalid_request', '预览请求过大')
        chunks.push(chunk)
      }
      const call = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (internalSchedule) return internalSchedule(call.method, call.params, connection.signal)
      const channel = route?.get(call?.method)
      const handler = channel && handlers[channel]
      if (!handler || !Array.isArray(call.args)) throw new DesktopError('invalid_request', '预览请求无效')
      const command = call.args[0]
      if (channel === DESKTOP_CHANNELS.files && (!files || ['open', 'reveal', 'download', 'trash', 'workspace-add', 'workspace-relink'].includes(command?.action)))
        throw new DesktopError('unsupported', '请在桌面应用中执行此文件操作')
      if (streaming && command?.action === 'watchRuns' && subscribeRunChanges) {
        await streamPreviewRunChanges(res, subscribeRunChanges)
        return null
      }
      if (streaming && command?.action === 'events') {
        const { events, ...page } = await handler(command) as { events: Parameters<typeof emit>[0][] }
        for (const event of events) emit(event)
        return page
      }
      if (streaming && (command?.action === 'send' || command?.action === 'resume')) {
        connection.signal.throwIfAborted()
        res.flushHeaders()
        return handler(command, emit, connection.signal)
      }
      return handler(...call.args)
    })
    if (streaming) emit({ type: 'reply', reply })
    res.end(streaming ? undefined : JSON.stringify(reply))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socket, () => { server.off('error', reject); resolve() })
  })
  return server
}
